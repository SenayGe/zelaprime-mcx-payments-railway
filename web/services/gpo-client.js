// web/services/gpo-client.js
// GPO/EMIS Gateway API client for Multicaixa payments

const crypto = require("crypto");

const GPO_API_URL = process.env.GPO_API_URL || "https://cerpagamentonline.emis.co.ao";

const DEFAULT_MOBILE_MODE = process.env.GPO_MOBILE_MODE || "PAYMENT";
const DEFAULT_QRCODE_MODE = process.env.GPO_QRCODE_MODE || "DISABLED";
const DEFAULT_CARD_MODE = process.env.GPO_CARD_MODE || "AUTHORIZATION";
const DEFAULT_TERMINAL_ID = process.env.GPO_TERMINAL_ID || "";

/**
 * Create a payment frame token for the GPO hosted payment page
 * @param {Object} params Payment parameters
 * @param {string} params.reference Unique payment reference (15 chars max)
 * @param {string} params.amount Amount in major units as string (AOA)
 * @param {string} params.callbackUrl URL for payment completion callback
 * @returns {Promise<{tokenId: string, timeToLiveMs: number, expiresAt: string|null}>}
 */
async function createFrameToken({
  reference,
  amount,
  callbackUrl,
}) {
  const frameToken = process.env.GPO_FRAME_TOKEN;
  if (!frameToken) {
    throw new Error("Missing GPO_FRAME_TOKEN environment variable");
  }

  const payload = {
    reference,
    amount,
    token: frameToken,
    mobile: DEFAULT_MOBILE_MODE,
    qrCode: DEFAULT_QRCODE_MODE,
    card: DEFAULT_CARD_MODE,
    callbackUrl,
  };

  if (DEFAULT_TERMINAL_ID) {
    payload.terminal = DEFAULT_TERMINAL_ID;
  }

  const response = await fetch(
    `${GPO_API_URL}/online-payment-gateway/webframe/v1/frameToken`,
    {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GPO API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();

  if (!data?.id) {
    throw new Error(`GPO API error: missing token id`);
  }

  const timeToLiveMs =
    typeof data.timeToLive === "number" ? data.timeToLive : null;
  const expiresAt =
    timeToLiveMs != null
      ? new Date(Date.now() + timeToLiveMs).toISOString()
      : null;

  return {
    tokenId: data.id,
    timeToLiveMs,
    expiresAt,
  };
}

/**
 * Verify GPO callback signature
 * @param {string} payload Raw request body
 * @param {string} signature Signature from X-GPO-Signature header
 * @returns {boolean}
 */
function verifyCallbackSignature(payload, signature) {
  const secret = process.env.GPO_CALLBACK_SECRET;
  if (!secret) {
    console.warn("GPO_CALLBACK_SECRET not set, skipping signature verification");
    return true;
  }

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(payload, "utf8")
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(signature, "hex"),
    Buffer.from(expectedSignature, "hex")
  );
}

/**
 * Parse and validate GPO callback payload
 * @param {Object} payload Parsed callback payload
 * @returns {{reference: string, status: string, amount: number, transactionId: string, currency: string|null}}
 */
function parseCallback(payload) {
  const reference =
    payload?.merchantReferenceNumber || payload?.reference?.id || null;
  const { status, amount, currency, id } = payload || {};

  if (!reference || !status) {
    throw new Error("Invalid callback payload: missing required fields");
  }

  return {
    reference,
    status, // SUCCESS, APPROVED, ACCEPTED, FAILED, EXPIRED, CANCELLED
    amount: Number(amount),
    transactionId: id,
    currency: currency || null,
  };
}

/**
 * Generate a unique 15-character payment reference
 * @param {string} orderNumber Shopify order number (e.g., "#1234")
 * @returns {string}
 */
function generateReference(orderNumber) {
  // Remove # and non-alphanumeric characters from order number
  const cleanOrder = (orderNumber || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 6);
  // Add timestamp component for uniqueness
  const timestamp = Date.now().toString(36).toUpperCase();
  // Add random suffix
  const random = crypto.randomBytes(2).toString("hex").toUpperCase();
  // Combine and ensure max 15 chars
  return `MCX${cleanOrder}${timestamp}${random}`.slice(0, 15);
}

module.exports = {
  createFrameToken,
  verifyCallbackSignature,
  parseCallback,
  generateReference,
};
