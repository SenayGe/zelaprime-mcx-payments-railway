// web/app.js
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
require("dotenv/config");

const { initDatabase } = require("./config/database");
const mcxSessionsRouter = require("./routes/mcx-sessions");
const mcxCallbackRouter = require("./routes/mcx-callback");
const shopifyWebhooksRouter = require("./routes/shopify-webhooks");
const shopifyAuthRouter = require("./routes/shopify-auth");
const paymentService = require("./services/payment-service");
const shopifyClient = require("./services/shopify-client");

const app = express();
const ORDER_NOT_READY_RESPONSE = Object.freeze({
  error: "Order not ready yet",
  code: "ORDER_NOT_READY",
  retryable: true,
});

function isOrderNotReadyError(err) {
  if (typeof shopifyClient.isOrderNotReadyError === "function") {
    return shopifyClient.isOrderNotReadyError(err);
  }
  return err?.code === "ORDER_NOT_READY" && err?.retryable === true;
}

function buildOrderNotReadyResponse() {
  return { ...ORDER_NOT_READY_RESPONSE };
}

function getSingleQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeStatusUrlPathname(pathname) {
  const normalized = String(pathname || "").replace(/\/+$/, "");
  return normalized || "/";
}

function parseStatusUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    const params = Array.from(parsed.searchParams.entries()).sort(
      ([leftKey, leftValue], [rightKey, rightValue]) => {
        if (leftKey === rightKey) {
          return leftValue.localeCompare(rightValue);
        }
        return leftKey.localeCompare(rightKey);
      }
    );
    const pathname = normalizeStatusUrlPathname(parsed.pathname);
    const search = new URLSearchParams(params).toString();

    return {
      href: `${parsed.origin.toLowerCase()}${pathname}${search ? `?${search}` : ""}`,
    };
  } catch {
    return null;
  }
}

function compareOrderStatusUrls(expectedUrl, providedUrl) {
  const expected = parseStatusUrl(expectedUrl);
  const provided = parseStatusUrl(providedUrl);

  return {
    expectedParsed: Boolean(expected),
    providedParsed: Boolean(provided),
    matches: Boolean(expected && provided && expected.href === provided.href),
  };
}

// Initialize database on cold start (best effort)
initDatabase().catch((err) => {
  console.error("Failed to initialize database:", err);
});

// Allowed origins for CORS
const ALLOWED_ORIGINS = [
  /\.myshopify\.com$/,
  /\.shopifypreview\.com$/,
  /checkout\.shopify\.com$/,
  /\.shopify\.com$/,
  /\.shopifycdn\.com$/,
  /.*\.ngrok-free\.app$/,
  /mcx-order-detail\.vercel\.app$/,
  /zelaprime-mcx-payments\.vercel\.app/,
];
const EXTRA_ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const EXTRA_ALLOWED_ORIGIN_SET = new Set(EXTRA_ALLOWED_ORIGINS);

// --- Middleware ---

// Raw body capture for webhook signature verification
app.use((req, res, next) => {
  if (req.path.includes("/callback") || req.path.includes("/webhooks")) {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      req.rawBody = data;
      try {
        req.body = JSON.parse(data);
      } catch {
        req.body = {};
      }
      next();
    });
  } else {
    next();
  }
});

// JSON parsing for non-webhook routes
app.use(express.json());

// CORS configuration
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      const ok =
        ALLOWED_ORIGINS.some((re) => re.test(origin)) ||
        EXTRA_ALLOWED_ORIGIN_SET.has(origin);
      return cb(ok ? null : new Error("Not allowed by CORS"), ok);
    },
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

// --- Routes ---

// Health check
app.get("/health", (_req, res) => res.send("ok"));

// Original order-total endpoint (backward compatible)
app.get("/api/order-total", async (req, res) => {
  let orderGid = null;
  try {
    const orderId = req.query.orderId;
    if (!orderId) return res.status(400).json({ error: "Missing orderId" });

    const normalizedOrderId = String(orderId);
    orderGid = normalizedOrderId.startsWith("gid://shopify/Order/")
      ? normalizedOrderId
      : `gid://shopify/Order/${normalizedOrderId}`;
    const ord = await shopifyClient.getOrder(orderGid);
    let financialStatus = ord.financialStatus;
    const paymentGatewayNames = Array.isArray(ord.paymentGatewayNames)
      ? ord.paymentGatewayNames
      : [];
    const paymentMethodType = paymentService.getPaymentMethodType(paymentGatewayNames);

    // If gateway callback already confirmed payment, reflect paid state immediately
    // and attempt to reconcile Shopify in the background path.
    try {
      const hasConfirmedLocalPayment =
        await paymentService.hasConfirmedPaymentForOrder(orderGid);

      if (
        hasConfirmedLocalPayment &&
        financialStatus !== "PAID" &&
        financialStatus !== "PARTIALLY_PAID"
      ) {
        try {
          await shopifyClient.markOrderAsPaid(orderGid);
          console.log(`Order ${orderGid} marked as paid via reconciliation`);
        } catch (markErr) {
          console.error(
            `Failed to reconcile order ${orderGid} as paid: ${markErr.message}`
          );
        }
        financialStatus = "PAID";
      }
    } catch (reconcileErr) {
      console.error(
        `Failed checking local payment status for ${orderGid}: ${reconcileErr.message}`
      );
    }

    return res.json({
      orderId: ord.id,
      orderName: ord.name,
      amount: ord.amount ?? null,
      currencyCode: ord.currency ?? null,
      financialStatus,
      createdAt: ord.createdAt ?? null,
      paymentGatewayNames,
      paymentMethodType,
    });
  } catch (e) {
    if (isOrderNotReadyError(e)) {
      console.warn(
        `Order not ready for /api/order-total (${orderGid || "unknown"}): ${e.message}`
      );
      return res.status(409).json(buildOrderNotReadyResponse());
    }
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// MCX payment sessions
app.use("/api/mcx/sessions", mcxSessionsRouter);

// MCX callback (from GPO)
app.use("/api/mcx/callback", mcxCallbackRouter);

// Shopify webhooks
app.use("/api/shopify/webhooks", shopifyWebhooksRouter);

// Shopify OAuth install/token flow
app.use("/api/auth", shopifyAuthRouter);

// Email payment link (on-demand session)
app.get("/pay/email", async (req, res) => {
  let orderGid = null;
  try {
    const idParam = getSingleQueryValue(req.query.id);
    const orderIdParam = getSingleQueryValue(req.query.order_id);
    const statusUrlParam = getSingleQueryValue(req.query.order_status_url);
    const requestContext = {
      hasIdParam: Boolean(idParam),
      hasOrderIdParam: Boolean(orderIdParam),
      hasOrderStatusUrl: Boolean(statusUrlParam),
    };
    const orderIdParamValue = idParam || orderIdParam;

    if (!orderIdParamValue) {
      console.warn("Email payment link missing order identifier", requestContext);
      return res.status(400).send("Missing id or order_id");
    }

    if (!statusUrlParam) {
      console.warn("Email payment link missing order_status_url", requestContext);
      return res.status(400).send("Missing order_status_url");
    }

    const orderId = String(orderIdParamValue).trim();
    const orderStatusUrl = String(statusUrlParam).trim();
    orderGid = orderId.startsWith("gid://shopify/Order/")
      ? orderId
      : `gid://shopify/Order/${orderId}`;

    const order = await shopifyClient.getOrder(orderGid);
    if (!order?.statusPageUrl) {
      console.warn("Email payment link missing customer status URL", requestContext);
      return res.status(500).send("Order is missing customer status URL");
    }

    const statusUrlComparison = compareOrderStatusUrls(
      order.statusPageUrl,
      orderStatusUrl
    );
    if (!statusUrlComparison.matches) {
      console.warn("Email payment link rejected", {
        ...requestContext,
        expectedStatusUrlParsed: statusUrlComparison.expectedParsed,
        providedStatusUrlParsed: statusUrlComparison.providedParsed,
        statusUrlMatched: statusUrlComparison.matches,
      });
      return res.status(401).send("Invalid order_status_url");
    }

    if (order.financialStatus !== "PENDING" && order.financialStatus !== "PARTIALLY_PAID") {
      return res.redirect(302, order.statusPageUrl);
    }

    const session = await paymentService.createPaymentSession(orderGid);
    return res.redirect(302, session.paymentUrl);
  } catch (err) {
    if (isOrderNotReadyError(err)) {
      console.warn(
        `Order not ready for /pay/email (${orderGid || "unknown"}): ${err.message}`
      );
      return res
        .status(409)
        .send("Order not ready yet. Please retry in a few seconds.");
    }
    console.error("Error creating email payment link:", err);
    return res.status(500).send("Failed to create payment link");
  }
});

// Payment page
app.get("/pay/:paymentId", async (req, res) => {
  try {
    const { paymentId } = req.params;
    const payment = await paymentService.getPaymentSession(paymentId);

    const purchaseToken = payment?.purchase_token ?? payment?.purchaseToken ?? null;
    if (!purchaseToken && process.env.DEBUG_PAY === "1") {
      const keys = payment && typeof payment === "object" ? Object.keys(payment) : [];
      console.log(`Missing purchase_token for paymentId=${paymentId}`, keys);
    }

    if (purchaseToken) {
      const gpoBaseUrl = (process.env.GPO_API_URL || "https://gpo.emis.co.ao")
        .replace(/\/$/, "");
      const frameUrl = `${gpoBaseUrl}/online-payment-gateway/webframe/frame?token=${purchaseToken}`;
      return res.redirect(302, frameUrl);
    }

    // Fallback error page when token is missing
    const templatePath = path.join(__dirname, "templates", "payment-page.html");
    let html = fs.readFileSync(templatePath, "utf8");
    html = html.replace(/\{\{PAYMENT_ID\}\}/g, paymentId);
    html = html.replace(/\{\{ORDER_NUMBER\}\}/g, payment.order_number || "");
    html = html.replace(/\{\{AMOUNT\}\}/g, "");
    html = html.replace(/\{\{FRAME_URL\}\}/g, () => "");

    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (err) {
    console.error("Error rendering payment page:", err);
    res.status(404).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Pagamento não encontrado</title></head>
      <body style="font-family: sans-serif; padding: 40px; text-align: center;">
        <h1>Pagamento não encontrado</h1>
        <p>O link de pagamento é inválido ou expirou.</p>
      </body>
      </html>
    `);
  }
});

module.exports = app;
