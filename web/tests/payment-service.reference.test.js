const test = require("node:test");
const assert = require("node:assert/strict");

const paymentServicePath = require.resolve("../services/payment-service");
const databasePath = require.resolve("../config/database");
const shopifyClientPath = require.resolve("../services/shopify-client");

function createReferenceDb({
  hasPaid = false,
  existingReference = null,
  failFirstInsertWithUnique = false,
} = {}) {
  const state = {
    hasPaid,
    existingReference,
    failRemaining: failFirstInsertWithUnique ? 1 : 0,
    insertCount: 0,
  };

  const db = {
    async execute(query) {
      const sql = query?.sql || "";
      const args = query?.args || [];

      if (sql.includes("SELECT 1 FROM multicaixa_payments")) {
        return { rows: state.hasPaid ? [{ one: 1 }] : [] };
      }

      if (
        sql.includes("SELECT reference, expires_at FROM multicaixa_payments") &&
        sql.includes("payment_method = 'REFERENCE'")
      ) {
        if (state.existingReference) {
          return {
            rows: [
              {
                reference: state.existingReference.reference,
                expires_at: state.existingReference.expires_at,
              },
            ],
          };
        }
        return { rows: [] };
      }

      if (
        sql.includes("INSERT INTO multicaixa_payments") &&
        sql.includes("'REFERENCE'")
      ) {
        state.insertCount += 1;
        if (state.failRemaining > 0) {
          state.failRemaining -= 1;
          throw new Error("UNIQUE constraint failed: multicaixa_payments.reference");
        }

        state.existingReference = {
          reference: args[3],
          expires_at: args[7],
        };
        return { rowsAffected: 1 };
      }

      throw new Error(`Unexpected SQL in test double: ${sql}`);
    },
  };

  return { db, state };
}

function loadPaymentServiceWithMocks({ db, getOrder, markOrderAsPaid }) {
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
      getOrder: getOrder || (async () => null),
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

function buildReferenceOrder(overrides = {}) {
  const defaultCreatedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  return {
    id: "gid://shopify/Order/101",
    name: "ZP-101",
    amount: "250.0",
    currency: "AOA",
    financialStatus: "PENDING",
    createdAt: defaultCreatedAt,
    paymentGatewayNames: ["Pagamento por referência"],
    ...overrides,
  };
}

test("getPaymentMethodType matches configured payment names", async () => {
  const previousExpress = process.env.PAYMENT_METHOD_EXPRESS_MATCH;
  const previousReference = process.env.PAYMENT_METHOD_REFERENCE_MATCH;
  delete process.env.PAYMENT_METHOD_EXPRESS_MATCH;
  delete process.env.PAYMENT_METHOD_REFERENCE_MATCH;

  const { db } = createReferenceDb();
  const { paymentService, restore } = loadPaymentServiceWithMocks({
    db,
    getOrder: async () => buildReferenceOrder(),
  });

  try {
    assert.equal(
      paymentService.getPaymentMethodType(["MULTICAIXA Express"]),
      paymentService.PAYMENT_METHOD_TYPES.EXPRESS
    );
    assert.equal(
      paymentService.getPaymentMethodType(["Pagamento por Referência no ATM"]),
      paymentService.PAYMENT_METHOD_TYPES.REFERENCE
    );
    assert.equal(
      paymentService.getPaymentMethodType(["Cash on Delivery"]),
      paymentService.PAYMENT_METHOD_TYPES.OTHER
    );
  } finally {
    if (previousExpress == null) {
      delete process.env.PAYMENT_METHOD_EXPRESS_MATCH;
    } else {
      process.env.PAYMENT_METHOD_EXPRESS_MATCH = previousExpress;
    }

    if (previousReference == null) {
      delete process.env.PAYMENT_METHOD_REFERENCE_MATCH;
    } else {
      process.env.PAYMENT_METHOD_REFERENCE_MATCH = previousReference;
    }

    restore();
  }
});

test("createOrGetReferencePayment creates a numeric reference for eligible orders", async () => {
  const { db, state } = createReferenceDb();
  const order = buildReferenceOrder();
  const { paymentService, restore } = loadPaymentServiceWithMocks({
    db,
    getOrder: async () => order,
  });

  try {
    const result = await paymentService.createOrGetReferencePayment(order.id);

    assert.match(result.reference, /^\d{9}$/);
    assert.equal(result.amount, "250.0");
    assert.equal(result.currencyCode, "AOA");
    assert.equal(result.isExpired, false);
    assert.equal(state.insertCount, 1);
    assert.ok(Date.parse(result.expiresAt));
  } finally {
    restore();
  }
});

test("createOrGetReferencePayment returns existing reference without reinserting", async () => {
  const expiresAt = new Date(Date.now() + 45 * 60 * 1000).toISOString();
  const { db, state } = createReferenceDb({
    existingReference: { reference: "123456789", expires_at: expiresAt },
  });
  const order = buildReferenceOrder();
  const { paymentService, restore } = loadPaymentServiceWithMocks({
    db,
    getOrder: async () => order,
  });

  try {
    const result = await paymentService.createOrGetReferencePayment(order.id);
    assert.equal(result.reference, "123456789");
    assert.equal(result.isExpired, false);
    assert.equal(state.insertCount, 0);
  } finally {
    restore();
  }
});

test("createOrGetReferencePayment returns expired response when order is older than 2 hours", async () => {
  const previousExpiry = process.env.REFERENCE_PAYMENT_EXPIRY_HOURS;
  delete process.env.REFERENCE_PAYMENT_EXPIRY_HOURS;

  const { db, state } = createReferenceDb();
  const order = buildReferenceOrder({
    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  });
  const { paymentService, restore } = loadPaymentServiceWithMocks({
    db,
    getOrder: async () => order,
  });

  try {
    const result = await paymentService.createOrGetReferencePayment(order.id);
    assert.equal(result.reference, null);
    assert.equal(result.isExpired, true);
    assert.equal(state.insertCount, 0);
  } finally {
    if (previousExpiry == null) {
      delete process.env.REFERENCE_PAYMENT_EXPIRY_HOURS;
    } else {
      process.env.REFERENCE_PAYMENT_EXPIRY_HOURS = previousExpiry;
    }
    restore();
  }
});

test("createOrGetReferencePayment retries when reference generation collides", async () => {
  const { db, state } = createReferenceDb({ failFirstInsertWithUnique: true });
  const order = buildReferenceOrder();
  const { paymentService, restore } = loadPaymentServiceWithMocks({
    db,
    getOrder: async () => order,
  });

  try {
    const result = await paymentService.createOrGetReferencePayment(order.id);
    assert.match(result.reference, /^\d{9}$/);
    assert.equal(result.isExpired, false);
    assert.equal(state.insertCount, 2);
  } finally {
    restore();
  }
});
