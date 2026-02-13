// web/routes/shopify-auth.js
// OAuth flow to obtain/store a Shopify offline Admin API token.

const express = require("express");
const crypto = require("crypto");
const tokenStore = require("../services/shopify-token-store");

const router = express.Router();

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
const DEFAULT_SCOPES =
  "read_all_orders,read_orders,write_orders,customer_read_orders,customer_write_orders";
const STATE_TTL_MS = 10 * 60 * 1000;

function getCanonicalShop(input) {
  return String(input || "").trim().toLowerCase();
}

function hasValidShopDomain(shop) {
  return SHOP_DOMAIN_RE.test(shop);
}

function isEnvTokenConfigured() {
  const token = String(process.env.SHOPIFY_ADMIN_TOKEN || "").trim();
  return token.length > 0 && !token.startsWith("REPLACE_WITH_");
}

function getCallbackUrl() {
  const explicit = String(process.env.SHOPIFY_AUTH_CALLBACK_URL || "").trim();
  if (explicit) return explicit;

  const appUrl = String(process.env.APP_URL || "").trim().replace(/\/$/, "");
  if (!appUrl) return "";
  return `${appUrl}/api/auth/callback`;
}

function timingSafeEqualHex(a, b) {
  const left = Buffer.from(String(a || "").toLowerCase(), "utf8");
  const right = Buffer.from(String(b || "").toLowerCase(), "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function signState(shop, secret) {
  const nonce = crypto.randomBytes(12).toString("hex");
  const timestamp = Date.now().toString();
  const payload = `${shop}|${timestamp}|${nonce}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  return Buffer.from(`${payload}|${signature}`, "utf8").toString("base64url");
}

function verifyState(state, expectedShop, secret) {
  let decoded;
  try {
    decoded = Buffer.from(String(state || ""), "base64url").toString("utf8");
  } catch {
    return { ok: false, reason: "Invalid state encoding" };
  }

  const parts = decoded.split("|");
  if (parts.length !== 4) {
    return { ok: false, reason: "Invalid state payload" };
  }

  const [shop, timestamp, nonce, signature] = parts;
  if (!shop || !timestamp || !nonce || !signature) {
    return { ok: false, reason: "Invalid state payload" };
  }

  if (shop !== expectedShop) {
    return { ok: false, reason: "State/shop mismatch" };
  }

  const payload = `${shop}|${timestamp}|${nonce}`;
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  if (!timingSafeEqualHex(signature, expectedSignature)) {
    return { ok: false, reason: "Invalid state signature" };
  }

  const ageMs = Date.now() - Number(timestamp);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > STATE_TTL_MS) {
    return { ok: false, reason: "Expired state" };
  }

  return { ok: true };
}

function verifyOAuthHmac(queryString, providedHmac, secret) {
  const params = new URLSearchParams(queryString || "");
  const pairs = [];

  for (const [key, value] of params.entries()) {
    if (key === "hmac" || key === "signature") continue;
    pairs.push([key, value]);
  }

  pairs.sort((a, b) => a[0].localeCompare(b[0]));
  const message = pairs.map(([k, v]) => `${k}=${v}`).join("&");

  const expected = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("hex");

  return timingSafeEqualHex(expected, providedHmac);
}

router.get("/install", (req, res) => {
  const apiKey = String(process.env.SHOPIFY_API_KEY || "").trim();
  const apiSecret = String(process.env.SHOPIFY_API_SECRET || "").trim();
  const shop = getCanonicalShop(req.query.shop || process.env.SHOPIFY_SHOP);
  const callbackUrl = getCallbackUrl();
  const scopes = String(process.env.SHOPIFY_SCOPES || DEFAULT_SCOPES).trim();

  if (!apiKey || !apiSecret) {
    return res.status(500).json({
      error: "Missing SHOPIFY_API_KEY or SHOPIFY_API_SECRET",
    });
  }

  if (!shop || !hasValidShopDomain(shop)) {
    return res.status(400).json({
      error: "Invalid shop. Expected *.myshopify.com domain",
    });
  }

  if (!callbackUrl.startsWith("https://")) {
    return res.status(500).json({
      error: "Missing or invalid callback URL",
      hint: "Set APP_URL or SHOPIFY_AUTH_CALLBACK_URL with https://",
    });
  }

  const state = signState(shop, apiSecret);
  const authUrl = new URL(`https://${shop}/admin/oauth/authorize`);
  authUrl.searchParams.set("client_id", apiKey);
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("redirect_uri", callbackUrl);
  authUrl.searchParams.set("state", state);

  return res.redirect(302, authUrl.toString());
});

router.get("/callback", async (req, res) => {
  try {
    const apiKey = String(process.env.SHOPIFY_API_KEY || "").trim();
    const apiSecret = String(process.env.SHOPIFY_API_SECRET || "").trim();
    const shop = getCanonicalShop(req.query.shop);
    const code = String(req.query.code || "");
    const hmac = String(req.query.hmac || "");
    const state = String(req.query.state || "");

    if (!apiKey || !apiSecret) {
      return res.status(500).json({
        error: "Missing SHOPIFY_API_KEY or SHOPIFY_API_SECRET",
      });
    }

    if (!shop || !code || !hmac || !state) {
      return res.status(400).json({
        error: "Missing required OAuth callback params",
      });
    }

    if (!hasValidShopDomain(shop)) {
      return res.status(400).json({ error: "Invalid shop domain" });
    }

    const stateResult = verifyState(state, shop, apiSecret);
    if (!stateResult.ok) {
      return res.status(401).json({ error: stateResult.reason });
    }

    const queryString = req.originalUrl.split("?")[1] || "";
    if (!verifyOAuthHmac(queryString, hmac, apiSecret)) {
      return res.status(401).json({ error: "Invalid callback HMAC" });
    }

    const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: apiKey,
        client_secret: apiSecret,
        code,
      }),
    });

    const responseBody = await tokenResponse.text();
    let parsedBody = {};
    try {
      parsedBody = JSON.parse(responseBody);
    } catch {
      parsedBody = {};
    }

    if (!tokenResponse.ok) {
      return res.status(502).json({
        error: `Token exchange failed (${tokenResponse.status})`,
        details: responseBody,
      });
    }

    const accessToken = String(parsedBody.access_token || "").trim();
    const scopes = String(parsedBody.scope || "").trim();

    if (!accessToken) {
      return res.status(502).json({
        error: "Token exchange response missing access_token",
      });
    }

    await tokenStore.upsertAccessToken(shop, accessToken, scopes);

    return res.status(200).send(`
      <!doctype html>
      <html>
      <head><meta charset="utf-8"><title>MCX App Installed</title></head>
      <body style="font-family: sans-serif; padding: 24px;">
        <h2>Shopify token stored</h2>
        <p>Shop: ${shop}</p>
        <p>You can close this tab and continue app setup in Shopify.</p>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("OAuth callback error:", err);
    return res.status(500).json({ error: "Unexpected OAuth callback error" });
  }
});

router.get("/status", async (req, res) => {
  try {
    const shop = getCanonicalShop(req.query.shop || process.env.SHOPIFY_SHOP);
    if (!shop || !hasValidShopDomain(shop)) {
      return res.status(400).json({ error: "Invalid shop domain" });
    }

    if (isEnvTokenConfigured()) {
      return res.json({
        shop,
        ready: true,
        tokenSource: "env",
      });
    }

    const token = await tokenStore.getAccessToken(shop);
    return res.json({
      shop,
      ready: Boolean(token),
      tokenSource: token ? "database" : "none",
    });
  } catch (err) {
    console.error("OAuth status check error:", err);
    return res.status(500).json({ error: "Failed to check auth status" });
  }
});

module.exports = router;
