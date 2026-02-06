// web/routes/shopify-webhooks.js
// Shopify webhook handlers

const express = require("express");
const shopifyClient = require("../services/shopify-client");
const paymentService = require("../services/payment-service");

const router = express.Router();

/**
 * POST /api/shopify/webhooks/orders/cancelled
 * Handle order cancellation - cancel any pending payment sessions
 */
router.post("/orders/cancelled", async (req, res) => {
  try {
    // Get raw body for signature verification (stored by middleware)
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const hmacHeader = req.headers["x-shopify-hmac-sha256"];

    // Verify Shopify webhook signature
    if (
      hmacHeader &&
      !shopifyClient.verifyWebhookSignature(rawBody, hmacHeader)
    ) {
      console.error("Invalid Shopify webhook signature");
      return res.status(401).json({ error: "Invalid signature" });
    }

    const orderData = req.body;
    const orderGid = `gid://shopify/Order/${orderData.id}`;

    console.log(`Order cancelled webhook received: ${orderGid}`);

    // Cancel any pending payment sessions for this order
    await paymentService.cancelPaymentByOrder(orderGid);

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Error processing order cancelled webhook:", err);
    // Return 200 to acknowledge receipt even on error
    return res.status(200).json({ received: true, error: err.message });
  }
});

/**
 * POST /api/shopify/webhooks/compliance
 * Handle GDPR compliance webhooks
 */
router.post("/compliance", async (req, res) => {
  try {
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const hmacHeader = req.headers["x-shopify-hmac-sha256"];

    // Verify Shopify webhook signature
    // if (
    //   hmacHeader &&
    //   !shopifyClient.verifyWebhookSignature(rawBody, hmacHeader)
    // ) {
    //   console.error("Invalid Shopify webhook signature");
    //   return res.status(401).json({ error: "Invalid signature" });
    // }

    if (
      !hmacHeader ||
      !shopifyClient.verifyWebhookSignature(rawBody, hmacHeader)
    ) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const topic = req.headers["x-shopify-topic"];
    console.log(`Compliance webhook received: ${topic}`);

    // Handle different compliance topics
    switch (topic) {
      case "customers/data_request":
        // Customer requested their data
        // We only store order IDs and payment references, which can be provided
        console.log(
          "Customer data request - payment records can be exported if needed",
        );
        break;

      case "customers/redact":
        // Customer requested data deletion
        // Our payment records are tied to orders, not customers directly
        // No personal customer data is stored beyond order reference
        console.log(
          "Customer redact - no personal data stored in payment records",
        );
        break;

      case "shop/redact":
        // Shop data deletion (48 hours after app uninstall)
        // Should delete all data related to this shop
        console.log("Shop redact - all payment records should be purged");
        // In production, implement: DELETE FROM multicaixa_payments WHERE shop_domain = ?
        break;

      default:
        console.log(`Unknown compliance topic: ${topic}`);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Error processing compliance webhook:", err);
    return res.status(200).json({ received: true, error: err.message });
  }
});

module.exports = router;
