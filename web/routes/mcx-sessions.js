// web/routes/mcx-sessions.js
// Routes for creating and managing Multicaixa payment sessions

const express = require("express");
const rateLimit = require("express-rate-limit");
const paymentService = require("../services/payment-service");

const router = express.Router();

// Rate limit: 10 session creations per order per 15 minutes
const createSessionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  keyGenerator: (req) => {
    // Rate limit per order ID
    return req.body?.orderId || req.ip;
  },
  message: { error: "Too many payment sessions created, please try again later" },
});

function isValidOrderId(orderId) {
  return typeof orderId === "string" && orderId.startsWith("gid://shopify/Order/");
}

/**
 * POST /api/mcx/sessions
 * Create a new payment session for an order
 * Body: { orderId: "gid://shopify/Order/..." }
 */
router.post("/", createSessionLimiter, async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: "Missing orderId" });
    }

    // Validate orderId format
    if (!isValidOrderId(orderId)) {
      return res.status(400).json({ error: "Invalid orderId format" });
    }

    const session = await paymentService.createPaymentSession(orderId);

    return res.json({
      paymentId: session.paymentId,
      paymentUrl: session.paymentUrl,
      expiresAt: session.expiresAt,
    });
  } catch (err) {
    console.error("Error creating payment session:", err);

    if (err.message.includes("not pending")) {
      return res.status(400).json({ error: err.message });
    }

    return res.status(500).json({ error: "Failed to create payment session" });
  }
});

/**
 * POST /api/mcx/sessions/reference
 * Create or return a manual reference payment session for an order
 * Body: { orderId: "gid://shopify/Order/..." }
 */
router.post("/reference", createSessionLimiter, async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: "Missing orderId" });
    }

    if (!isValidOrderId(orderId)) {
      return res.status(400).json({ error: "Invalid orderId format" });
    }

    const referenceSession =
      await paymentService.createOrGetReferencePayment(orderId);

    return res.json(referenceSession);
  } catch (err) {
    console.error("Error creating reference payment session:", err);

    if (
      err.message.includes("not pending") ||
      err.message.includes("not configured")
    ) {
      return res.status(400).json({ error: err.message });
    }

    return res
      .status(500)
      .json({ error: "Failed to create reference payment session" });
  }
});

/**
 * GET /api/mcx/sessions/:paymentId/status
 * Get the current status of a payment session
 */
router.get("/:paymentId/status", async (req, res) => {
  try {
    const { paymentId } = req.params;

    const payment = await paymentService.getPaymentSession(paymentId);

    return res.json({
      paymentId: payment.id,
      status: payment.status,
      orderNumber: payment.order_number,
      paidAt: payment.paid_at,
    });
  } catch (err) {
    console.error("Error getting payment status:", err);

    if (err.message.includes("not found")) {
      return res.status(404).json({ error: "Payment session not found" });
    }

    return res.status(500).json({ error: "Failed to get payment status" });
  }
});

/**
 * GET /api/mcx/orders/:orderId/payment-status
 * Get the payment status for an order
 */
router.get("/orders/:orderId/payment-status", async (req, res) => {
  try {
    const { orderId } = req.params;
    const decodedOrderId = decodeURIComponent(orderId);

    const result = await paymentService.getPaymentStatusByOrder(decodedOrderId);

    return res.json(result);
  } catch (err) {
    console.error("Error getting order payment status:", err);
    return res.status(500).json({ error: "Failed to get payment status" });
  }
});

module.exports = router;
