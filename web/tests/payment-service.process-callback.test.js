const test = require("node:test");
const assert = require("node:assert/strict");

const paymentServicePath = require.resolve("../services/payment-service");
const databasePath = require.resolve("../config/database");
const shopifyClientPath = require.resolve("../services/shopify-client");

function createDbWithPayment(paymentRow) {
  const state = {
    payment: { ...paymentRow },
    updateCount: 0,
  };

  const db = {
    async execute(query) {
      const sql = query?.sql || "";
      const args = query?.args || [];

      if (sql.includes("SELECT * FROM multicaixa_payments WHERE reference = ?")) {
        if (state.payment.reference === args[0]) {
          return { rows: [{ ...state.payment }] };
        }
        return { rows: [] };
      }

      if (sql.includes("UPDATE multicaixa_payments") && sql.includes("callback_payload_hash")) {
        const [status, callbackPayloadHash, paidAt, paymentId] = args;
        if (paymentId !== state.payment.id) {
          throw new Error(`Unexpected payment id update: ${paymentId}`);
        }
        state.payment.status = status;
        state.payment.callback_payload_hash = callbackPayloadHash;
        state.payment.paid_at = paidAt;
        state.updateCount += 1;
        return { rowsAffected: 1 };
      }

      if (sql.includes("SELECT 1 FROM multicaixa_payments")) {
        return { rows: state.payment.status === "PAID" ? [{ one: 1 }] : [] };
      }

      throw new Error(`Unexpected SQL in test double: ${sql}`);
    },
  };

  return { db, state };
}

function loadPaymentServiceWithMocks({ db, markOrderAsPaid }) {
  const previousCache = new Map([
    [paymentServicePath, require.cache[paymentServicePath]],
    [databasePath, require.cache[databasePath]],
    [shopifyClientPath, require.cache[shopifyClientPath]],
  ]);

  delete require.cache[paymentServicePath];
  delete require.cache[databasePath];
  delete require.cache[shopifyClientPath];

  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: {
      getDatabase: () => db,
    },
  };

  require.cache[shopifyClientPath] = {
    id: shopifyClientPath,
    filename: shopifyClientPath,
    loaded: true,
    exports: {
      getOrder: async () => {
        throw new Error("getOrder should not be called in processCallback tests");
      },
      markOrderAsPaid: markOrderAsPaid || (async () => {}),
      verifyWebhookSignature: () => true,
    },
  };

  const paymentService = require(paymentServicePath);

  return {
    paymentService,
    restore() {
      delete require.cache[paymentServicePath];
      delete require.cache[databasePath];
      delete require.cache[shopifyClientPath];
      for (const [modulePath, cachedModule] of previousCache.entries()) {
        if (cachedModule) {
          require.cache[modulePath] = cachedModule;
        } else {
          delete require.cache[modulePath];
        }
      }
    },
  };
}

function buildBasePaymentRow() {
  return {
    id: "payment-1",
    reference: "MCXREF100",
    amount_minor: 1000,
    callback_payload_hash: null,
    status: "CREATED",
    paid_at: null,
    shopify_order_gid: "gid://shopify/Order/1",
  };
}

test("processCallback marks paid statuses and calls Shopify", async () => {
  const { db, state } = createDbWithPayment(buildBasePaymentRow());
  let markPaidCalls = 0;
  const { paymentService, restore } = loadPaymentServiceWithMocks({
    db,
    markOrderAsPaid: async () => {
      markPaidCalls += 1;
    },
  });

  try {
    const result = await paymentService.processCallback(
      { reference: "MCXREF100", status: "COMPLETED", amount: 10 },
      JSON.stringify({ callback: 1 })
    );

    assert.equal(result.success, true);
    assert.equal(state.payment.status, "PAID");
    assert.equal(typeof state.payment.callback_payload_hash, "string");
    assert.ok(state.payment.callback_payload_hash.length > 0);
    assert.ok(state.payment.paid_at);
    assert.equal(markPaidCalls, 1);
  } finally {
    restore();
  }
});

test("processCallback accepts amount in minor units too", async () => {
  const { db, state } = createDbWithPayment(buildBasePaymentRow());
  let markPaidCalls = 0;
  const { paymentService, restore } = loadPaymentServiceWithMocks({
    db,
    markOrderAsPaid: async () => {
      markPaidCalls += 1;
    },
  });

  try {
    await paymentService.processCallback(
      { reference: "MCXREF100", status: "SUCCESS", amount: 1000 },
      JSON.stringify({ callback: 2 })
    );

    assert.equal(state.payment.status, "PAID");
    assert.equal(markPaidCalls, 1);
  } finally {
    restore();
  }
});

test("processCallback stores non-paid statuses without paid_at", async () => {
  const { db, state } = createDbWithPayment(buildBasePaymentRow());
  let markPaidCalls = 0;
  const { paymentService, restore } = loadPaymentServiceWithMocks({
    db,
    markOrderAsPaid: async () => {
      markPaidCalls += 1;
    },
  });

  try {
    const result = await paymentService.processCallback(
      { reference: "MCXREF100", status: "REJECTED", amount: 10 },
      JSON.stringify({ callback: 3 })
    );

    assert.equal(result.success, true);
    assert.equal(state.payment.status, "REJECTED");
    assert.equal(state.payment.paid_at, null);
    assert.equal(typeof state.payment.callback_payload_hash, "string");
    assert.equal(markPaidCalls, 0);
  } finally {
    restore();
  }
});

test("processCallback is idempotent on duplicate callback payload", async () => {
  const { db, state } = createDbWithPayment(buildBasePaymentRow());
  let markPaidCalls = 0;
  const { paymentService, restore } = loadPaymentServiceWithMocks({
    db,
    markOrderAsPaid: async () => {
      markPaidCalls += 1;
    },
  });

  try {
    const rawPayload = JSON.stringify({ callback: 4 });

    const firstResult = await paymentService.processCallback(
      { reference: "MCXREF100", status: "SUCCESS", amount: 10 },
      rawPayload
    );
    assert.equal(firstResult.success, true);
    assert.equal(state.updateCount, 1);

    const secondResult = await paymentService.processCallback(
      { reference: "MCXREF100", status: "SUCCESS", amount: 10 },
      rawPayload
    );
    assert.equal(secondResult.success, true);
    assert.equal(secondResult.duplicate, true);
    assert.equal(state.updateCount, 1);
    assert.equal(markPaidCalls, 1);
  } finally {
    restore();
  }
});

test("processCallback rejects true amount mismatches", async () => {
  const { db } = createDbWithPayment(buildBasePaymentRow());
  const { paymentService, restore } = loadPaymentServiceWithMocks({ db });

  try {
    await assert.rejects(
      () =>
        paymentService.processCallback(
          { reference: "MCXREF100", status: "SUCCESS", amount: 11 },
          JSON.stringify({ callback: 5 })
        ),
      /Amount mismatch/
    );
  } finally {
    restore();
  }
});
