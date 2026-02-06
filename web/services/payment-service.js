// web/services/payment-service.js
// Business logic for Multicaixa payment flow

const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { getDatabase } = require("../config/database");
const gpoClient = require("./gpo-client");
const shopifyClient = require("./shopify-client");

const APP_URL = (process.env.APP_URL || "https://pay.zelaprime.com").replace(/\/$/, "");

function normalizeRow(row, columns) {
  if (!row) return row;
  if (Array.isArray(row) && Array.isArray(columns)) {
    const obj = {};
    for (let i = 0; i < columns.length; i += 1) {
      obj[columns[i]] = row[i];
    }
    return obj;
  }
  return row;
}

function normalizeRows(result) {
  if (!result || !Array.isArray(result.rows)) return [];
  const columns = result.columns;
  return result.rows.map((row) => normalizeRow(row, columns));
}

/**
 * Create a new payment session for an order
 * @param {string} orderGid Shopify order GID
 * @returns {Promise<{paymentId: string, paymentUrl: string, expiresAt: string}>}
 */
async function createPaymentSession(orderGid) {
  const db = getDatabase();

  // Get order details from Shopify
  const order = await shopifyClient.getOrder(orderGid);

  // Validate order is unpaid or partially paid
  if (order.financialStatus !== "PENDING" && order.financialStatus !== "PARTIALLY_PAID") {
    throw new Error(`Order is not pending payment (status: ${order.financialStatus})`);
  }

  // Generate unique payment ID and reference
  const paymentId = uuidv4();
  const reference = gpoClient.generateReference(order.name);

  const parsedAmount = Number(order.amount);
  if (!Number.isFinite(parsedAmount)) {
    throw new Error(`Invalid order amount: ${order.amount}`);
  }

  // Convert amount to minor units (centavos) for storage
  const amountMinor = Math.round(parsedAmount * 100);

  // Format amount in major units as string for GPO
  const amountMajor = parsedAmount
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/(\.\d)0$/, "$1");

  // Create GPO payment frame
  const callbackUrl = `${APP_URL}/api/mcx/callback`;

  const gpoResult = await gpoClient.createFrameToken({
    reference,
    amount: amountMajor,
    callbackUrl,
  });

  // Store payment record
  await db.execute({
    sql: `INSERT INTO multicaixa_payments
          (id, shopify_order_gid, order_number, reference, amount_minor, currency, purchase_token, expires_at, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CREATED')`,
    args: [
      paymentId,
      orderGid,
      order.name,
      reference,
      amountMinor,
      order.currency,
      gpoResult.tokenId,
      gpoResult.expiresAt,
    ],
  });

  return {
    paymentId,
    paymentUrl: `${APP_URL}/pay/${paymentId}`,
    expiresAt: gpoResult.expiresAt,
  };
}

/**
 * Get payment session details
 * @param {string} paymentId Payment session ID
 * @returns {Promise<Object>}
 */
async function getPaymentSession(paymentId) {
  const db = getDatabase();

  const result = await db.execute({
    sql: `SELECT * FROM multicaixa_payments WHERE id = ?`,
    args: [paymentId],
  });

  const rows = normalizeRows(result);
  if (rows.length === 0) {
    throw new Error("Payment session not found");
  }

  return rows[0];
}

/**
 * Get payment status for an order
 * @param {string} orderGid Shopify order GID
 * @returns {Promise<{status: string, paymentId: string|null}>}
 */
async function getPaymentStatusByOrder(orderGid) {
  const db = getDatabase();

  const result = await db.execute({
    sql: `SELECT id, status FROM multicaixa_payments
          WHERE shopify_order_gid = ?
          ORDER BY created_at DESC LIMIT 1`,
    args: [orderGid],
  });

  const rows = normalizeRows(result);
  if (rows.length === 0) {
    return { status: "NONE", paymentId: null };
  }

  return {
    status: rows[0].status,
    paymentId: rows[0].id,
  };
}

/**
 * Process GPO callback and mark order as paid
 * @param {Object} callbackData Parsed callback data
 * @param {string} rawPayload Raw request body for replay protection
 * @returns {Promise<{success: boolean}>}
 */
async function processCallback(callbackData, rawPayload) {
  const db = getDatabase();
  const { reference, status, amount } = callbackData;

  // Find payment by reference
  const result = await db.execute({
    sql: `SELECT * FROM multicaixa_payments WHERE reference = ?`,
    args: [reference],
  });

  const rows = normalizeRows(result);
  if (rows.length === 0) {
    throw new Error(`Payment not found for reference: ${reference}`);
  }

  const payment = rows[0];

  // Check for replay attack
  const payloadHash = crypto
    .createHash("sha256")
    .update(rawPayload)
    .digest("hex");

  if (payment.callback_payload_hash === payloadHash) {
    console.log(`Duplicate callback detected for reference: ${reference}`);
    return { success: true, duplicate: true };
  }

  // Verify amount matches
  if (amount != null && Number.isFinite(Number(amount))) {
    const amountMinorFromCallback = Math.round(Number(amount) * 100);
    if (amountMinorFromCallback !== payment.amount_minor) {
      console.error(
        `Amount mismatch for ${reference}: expected ${payment.amount_minor}, got ${amountMinorFromCallback}`
      );
      throw new Error("Amount mismatch");
    }
  } else if (amount != null) {
    console.error(
      `Invalid callback amount for ${reference}: ${amount}`
    );
    throw new Error("Invalid callback amount");
  }

  // Update payment status
  const normalizedStatus = String(status).toUpperCase();
  const isPaid =
    normalizedStatus === "SUCCESS" || normalizedStatus === "APPROVED";
  const newStatus = isPaid ? "PAID" : normalizedStatus;
  const paidAt = isPaid ? new Date().toISOString() : null;

  await db.execute({
    sql: `UPDATE multicaixa_payments
          SET status = ?, callback_payload_hash = ?, updated_at = datetime('now'), paid_at = ?
          WHERE id = ?`,
    args: [newStatus, payloadHash, paidAt, payment.id],
  });

  // If payment successful, mark Shopify order as paid
  if (isPaid) {
    try {
      await shopifyClient.markOrderAsPaid(payment.shopify_order_gid);
      console.log(`Order ${payment.shopify_order_gid} marked as paid`);
    } catch (err) {
      console.error(`Failed to mark order as paid: ${err.message}`);
      // Don't throw - payment is still recorded, can retry later
    }
  }

  return { success: true };
}

/**
 * Cancel a payment session (e.g., when order is cancelled)
 * @param {string} orderGid Shopify order GID
 * @returns {Promise<void>}
 */
async function cancelPaymentByOrder(orderGid) {
  const db = getDatabase();

  await db.execute({
    sql: `UPDATE multicaixa_payments
          SET status = 'CANCELLED', updated_at = datetime('now')
          WHERE shopify_order_gid = ? AND status IN ('CREATED', 'PENDING')`,
    args: [orderGid],
  });
}

module.exports = {
  createPaymentSession,
  getPaymentSession,
  getPaymentStatusByOrder,
  processCallback,
  cancelPaymentByOrder,
};
