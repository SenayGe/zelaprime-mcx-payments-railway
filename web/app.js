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
const paymentService = require("./services/payment-service");
const shopifyClient = require("./services/shopify-client");

const app = express();

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
  try {
    const orderId = req.query.orderId;
    if (!orderId) return res.status(400).json({ error: "Missing orderId" });

    const shop = process.env.SHOPIFY_SHOP;
    const token = process.env.SHOPIFY_ADMIN_TOKEN;
    if (!shop || !token) {
      return res
        .status(500)
        .json({ error: "Missing SHOPIFY_SHOP or SHOPIFY_ADMIN_TOKEN" });
    }

    const query = `
      query ($id: ID!) {
        order(id: $id) {
          id
          name
          displayFinancialStatus
          currentTotalPriceSet { shopMoney { amount currencyCode } }
          totalPriceSet { shopMoney { amount currencyCode } }
        }
      }`;

    const r = await fetch(`https://${shop}/admin/api/2025-07/graphql.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: { id: orderId } }),
    });

    if (!r.ok) {
      const text = await r.text();
      return res.status(502).json({ error: `Shopify ${r.status}`, details: text });
    }

    const j = await r.json();
    if (j.errors) return res.status(502).json({ error: j.errors });

    const ord = j.data?.order;
    if (!ord) return res.status(404).json({ error: "Order not found" });

    const money =
      ord.currentTotalPriceSet?.shopMoney || ord.totalPriceSet?.shopMoney || null;

    return res.json({
      orderId: ord.id,
      orderName: ord.name,
      amount: money?.amount ?? null,
      currencyCode: money?.currencyCode ?? null,
      financialStatus: ord.displayFinancialStatus,
    });
  } catch (e) {
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

// Email payment link (on-demand session)
app.get("/pay/email", async (req, res) => {
  try {
    const orderIdParam = Array.isArray(req.query.order_id)
      ? req.query.order_id[0]
      : req.query.order_id;
    const statusUrlParam = Array.isArray(req.query.order_status_url)
      ? req.query.order_status_url[0]
      : req.query.order_status_url;

    if (!orderIdParam || !statusUrlParam) {
      return res.status(400).send("Missing order_id or order_status_url");
    }

    const orderId = String(orderIdParam);
    const orderStatusUrl = String(statusUrlParam);
    const orderGid = orderId.startsWith("gid://shopify/Order/")
      ? orderId
      : `gid://shopify/Order/${orderId}`;

    const order = await shopifyClient.getOrder(orderGid);
    if (!order?.statusPageUrl) {
      return res.status(400).send("Missing order status URL");
    }

    if (order.statusPageUrl !== orderStatusUrl) {
      return res.status(401).send("Invalid order status URL");
    }

    if (order.financialStatus !== "PENDING" && order.financialStatus !== "PARTIALLY_PAID") {
      return res.redirect(302, order.statusPageUrl);
    }

    const session = await paymentService.createPaymentSession(orderGid);
    return res.redirect(302, session.paymentUrl);
  } catch (err) {
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
