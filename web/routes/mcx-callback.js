// web/routes/mcx-callback.js
// GPO callback handler for payment completion notifications

const express = require("express");
const gpoClient = require("../services/gpo-client");
const paymentService = require("../services/payment-service");

const router = express.Router();

/**
 * POST /api/mcx/callback
 * Receives payment completion notifications from GPO/EMIS
 * This is the source of truth for payment status
 */
router.post("/", async (req, res) => {
  try {
    // Get raw body for signature verification (stored by middleware)
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const signature = req.headers["x-gpo-signature"];
    const referenceHint = getReferenceHint(req.body);

    // Verify callback signature
    if (signature && !gpoClient.verifyCallbackSignature(rawBody, signature)) {
      console.error(`Invalid GPO callback signature (reference=${referenceHint})`);
      return res.status(401).json({ error: "Invalid signature" });
    }

    // Parse callback payload
    const callbackData = gpoClient.parseCallback(req.body);
    console.log(`GPO callback received: reference=${callbackData.reference}, status=${callbackData.status}`);

    // Process the callback
    const result = await paymentService.processCallback(callbackData, rawBody);

    if (result.duplicate) {
      console.log("Duplicate callback ignored");
    }

    // Always return 200 to acknowledge receipt
    return res.status(200).json({ received: true });
  } catch (err) {
    const referenceHint = getReferenceHint(req.body);
    console.error(`Error processing GPO callback (reference=${referenceHint}):`, err);

    // Return 200 anyway to prevent GPO from retrying indefinitely
    // Log the error for investigation
    return res.status(200).json({ received: true, error: err.message });
  }
});

function getReferenceHint(payload) {
  if (!payload || typeof payload !== "object") {
    return "unknown";
  }

  return (
    payload.merchantReferenceNumber ||
    payload.merchantReference ||
    payload.merchant_reference ||
    payload.reference?.id ||
    (typeof payload.reference === "string" ? payload.reference : null) ||
    payload.referenceId ||
    "unknown"
  );
}

module.exports = router;
