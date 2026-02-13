const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const gpoClient = require("../services/gpo-client");

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
