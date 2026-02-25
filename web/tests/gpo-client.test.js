const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const gpoClient = require("../services/gpo-client");

function loadFreshGpoClient() {
  const modulePath = require.resolve("../services/gpo-client");
  delete require.cache[modulePath];
  return require("../services/gpo-client");
}

async function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : null;
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function withSecret(secret, fn) {
  const previous = process.env.GPO_CALLBACK_SECRET;
  process.env.GPO_CALLBACK_SECRET = secret;
  try {
    fn();
  } finally {
    if (previous == null) {
      delete process.env.GPO_CALLBACK_SECRET;
    } else {
      process.env.GPO_CALLBACK_SECRET = previous;
    }
  }
}

test("verifyCallbackSignature accepts valid hex signatures", () => {
  withSecret("unit-test-secret", () => {
    const payload = JSON.stringify({ event: "payment", id: "1" });
    const signatureHex = crypto
      .createHmac("sha256", "unit-test-secret")
      .update(payload, "utf8")
      .digest("hex");

    const isValid = gpoClient.verifyCallbackSignature(payload, signatureHex);
    assert.equal(isValid, true);
  });
});

test("verifyCallbackSignature accepts valid base64 signatures with and without padding", () => {
  withSecret("unit-test-secret", () => {
    const payload = JSON.stringify({ event: "payment", id: "2" });
    const signatureHex = crypto
      .createHmac("sha256", "unit-test-secret")
      .update(payload, "utf8")
      .digest("hex");
    const signatureBase64 = Buffer.from(signatureHex, "hex").toString("base64");
    const signatureBase64NoPadding = signatureBase64.replace(/=+$/, "");

    assert.equal(gpoClient.verifyCallbackSignature(payload, signatureBase64), true);
    assert.equal(gpoClient.verifyCallbackSignature(payload, signatureBase64NoPadding), true);
  });
});

test("verifyCallbackSignature rejects invalid signatures and does not throw on malformed input", () => {
  withSecret("unit-test-secret", () => {
    const payload = JSON.stringify({ event: "payment", id: "3" });
    assert.equal(gpoClient.verifyCallbackSignature(payload, "invalid"), false);
    assert.equal(gpoClient.verifyCallbackSignature(payload, "%%%%"), false);
    assert.equal(gpoClient.verifyCallbackSignature(payload, ""), false);
  });
});

test("parseCallback supports callback field variants", () => {
  const parsedA = gpoClient.parseCallback({
    merchantReferenceNumber: "MCXREF001",
    status: "success",
    amount: "10.50",
    currency: "AOA",
    id: "tx-1",
  });
  assert.equal(parsedA.reference, "MCXREF001");
  assert.equal(parsedA.status, "SUCCESS");
  assert.equal(parsedA.amount, 10.5);
  assert.equal(parsedA.currency, "AOA");
  assert.equal(parsedA.transactionId, "tx-1");

  const parsedB = gpoClient.parseCallback({
    merchantReference: "MCXREF002",
    paymentStatus: "approved",
    value: "20,25",
    currencyCode: "AOA",
    transactionId: "tx-2",
  });
  assert.equal(parsedB.reference, "MCXREF002");
  assert.equal(parsedB.status, "APPROVED");
  assert.equal(parsedB.amount, 20.25);
  assert.equal(parsedB.currency, "AOA");
  assert.equal(parsedB.transactionId, "tx-2");

  const parsedC = gpoClient.parseCallback({
    reference: { id: "MCXREF003", currency: "AOA" },
    transactionStatus: "completed",
    totalAmount: "1500",
    paymentId: "tx-3",
  });
  assert.equal(parsedC.reference, "MCXREF003");
  assert.equal(parsedC.status, "COMPLETED");
  assert.equal(parsedC.amount, 1500);
  assert.equal(parsedC.currency, "AOA");
  assert.equal(parsedC.transactionId, "tx-3");
});

test("parseCallback rejects payloads without required semantic fields", () => {
  assert.throws(
    () => gpoClient.parseCallback({ amount: 10, status: "SUCCESS" }),
    /missing required fields/i
  );

  assert.throws(
    () => gpoClient.parseCallback({ merchantReferenceNumber: "MCXREF004", amount: 10 }),
    /missing required fields/i
  );
});

test("createFrameToken uses default QR enabled and card disabled modes", async () => {
  await withEnv(
    {
      GPO_FRAME_TOKEN: "frame-token-test",
      GPO_API_URL: "https://gpo.example.test",
      GPO_MOBILE_MODE: null,
      GPO_QRCODE_MODE: null,
      GPO_CARD_MODE: null,
      GPO_TERMINAL_ID: null,
    },
    async () => {
      const previousFetch = global.fetch;
      let fetchPayload = null;

      global.fetch = async (_url, options) => {
        fetchPayload = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({ id: "token-default", timeToLive: 60000 }),
        };
      };

      try {
        const freshClient = loadFreshGpoClient();
        const result = await freshClient.createFrameToken({
          reference: "MCXREF100",
          amount: "10.5",
          callbackUrl: "https://app.example.test/api/mcx/callback",
        });

        assert.equal(result.tokenId, "token-default");
        assert.equal(fetchPayload.mobile, "PAYMENT");
        assert.equal(fetchPayload.qrCode, "PAYMENT");
        assert.equal(fetchPayload.card, "DISABLED");
      } finally {
        global.fetch = previousFetch;
      }
    }
  );
});

test("createFrameToken uses env mode overrides when provided", async () => {
  await withEnv(
    {
      GPO_FRAME_TOKEN: "frame-token-test",
      GPO_API_URL: "https://gpo.example.test",
      GPO_MOBILE_MODE: "DISABLED",
      GPO_QRCODE_MODE: "DISABLED",
      GPO_CARD_MODE: "AUTHORIZATION",
      GPO_TERMINAL_ID: null,
    },
    async () => {
      const previousFetch = global.fetch;
      let fetchPayload = null;

      global.fetch = async (_url, options) => {
        fetchPayload = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({ id: "token-override", timeToLive: 60000 }),
        };
      };

      try {
        const freshClient = loadFreshGpoClient();
        const result = await freshClient.createFrameToken({
          reference: "MCXREF101",
          amount: "30",
          callbackUrl: "https://app.example.test/api/mcx/callback",
        });

        assert.equal(result.tokenId, "token-override");
        assert.equal(fetchPayload.mobile, "DISABLED");
        assert.equal(fetchPayload.qrCode, "DISABLED");
        assert.equal(fetchPayload.card, "AUTHORIZATION");
      } finally {
        global.fetch = previousFetch;
      }
    }
  );
});
