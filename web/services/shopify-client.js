// web/services/shopify-client.js
// Shopify Admin API client for order operations

const tokenStore = require("./shopify-token-store");

const DEFAULT_ORDER_LOOKUP_MAX_ATTEMPTS = 4;
const DEFAULT_ORDER_LOOKUP_BASE_DELAY_MS = 250;
const DEFAULT_ORDER_LOOKUP_MAX_DELAY_MS = 2000;
const ORDER_NOT_READY_CODE = "ORDER_NOT_READY";

function hasUsableEnvToken() {
  const token = String(process.env.SHOPIFY_ADMIN_TOKEN || "").trim();
  return token.length > 0 && !token.startsWith("REPLACE_WITH_");
}

async function getShopAndToken() {
  const shop = String(process.env.SHOPIFY_SHOP || "").trim();
  if (!shop) {
    throw new Error("Missing SHOPIFY_SHOP");
  }

  if (hasUsableEnvToken()) {
    return { shop, token: String(process.env.SHOPIFY_ADMIN_TOKEN).trim() };
  }

  const storedToken = await tokenStore.getAccessToken(shop);
  if (!storedToken) {
    throw new Error(
      "Missing Shopify access token. Complete OAuth install at /api/auth/install first."
    );
  }

  return { shop, token: storedToken };
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getOrderLookupRetryConfig() {
  const maxAttempts = parsePositiveInt(
    process.env.SHOPIFY_ORDER_LOOKUP_MAX_ATTEMPTS,
    DEFAULT_ORDER_LOOKUP_MAX_ATTEMPTS
  );
  const baseDelayMs = parsePositiveInt(
    process.env.SHOPIFY_ORDER_LOOKUP_BASE_DELAY_MS,
    DEFAULT_ORDER_LOOKUP_BASE_DELAY_MS
  );
  const maxDelayMs = parsePositiveInt(
    process.env.SHOPIFY_ORDER_LOOKUP_MAX_DELAY_MS,
    DEFAULT_ORDER_LOOKUP_MAX_DELAY_MS
  );

  return {
    maxAttempts: Math.max(1, maxAttempts),
    baseDelayMs: Math.max(1, baseDelayMs),
    maxDelayMs: Math.max(1, Math.max(baseDelayMs, maxDelayMs)),
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildOrderNotReadyError(orderGid, attempts) {
  const err = new Error("Order not ready yet");
  err.code = ORDER_NOT_READY_CODE;
  err.retryable = true;
  err.orderGid = orderGid;
  err.attempts = attempts;
  return err;
}

function isOrderNotReadyError(err) {
  return err?.code === ORDER_NOT_READY_CODE && err?.retryable === true;
}

async function fetchOrderById({ shop, token, orderGid }) {
  const query = `
    query ($id: ID!) {
      order(id: $id) {
        id
        name
        createdAt
        statusPageUrl(audience: CUSTOMERVIEW, notificationUsage: WEB)
        paymentGatewayNames
        displayFinancialStatus
        currentTotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
      }
    }
  `;

  const response = await fetch(`https://${shop}/admin/api/2025-07/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables: { id: orderGid } }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify API error ${response.status}: ${text}`);
  }

  const json = await response.json();
  if (json.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  }

  return json.data?.order || null;
}

function normalizeOrder(order) {
  const money = order.currentTotalPriceSet?.shopMoney || order.totalPriceSet?.shopMoney;

  return {
    id: order.id,
    name: order.name,
    amount: money?.amount,
    currency: money?.currencyCode,
    financialStatus: order.displayFinancialStatus,
    createdAt: order.createdAt || null,
    paymentGatewayNames: Array.isArray(order.paymentGatewayNames)
      ? order.paymentGatewayNames
      : [],
    statusPageUrl: order.statusPageUrl,
  };
}

/**
 * Get order details from Shopify Admin API
 * @param {string} orderGid Shopify order GID (e.g., "gid://shopify/Order/123")
 * @returns {Promise<{id: string, name: string, amount: string, currency: string, financialStatus: string, createdAt?: string, paymentGatewayNames?: string[], statusPageUrl?: string}>}
 */
async function getOrder(orderGid) {
  const { shop, token } = await getShopAndToken();
  const retryConfig = getOrderLookupRetryConfig();

  for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt += 1) {
    const order = await fetchOrderById({ shop, token, orderGid });
    if (order) {
      return normalizeOrder(order);
    }

    if (attempt >= retryConfig.maxAttempts) {
      throw buildOrderNotReadyError(orderGid, attempt);
    }

    const backoffMs = Math.min(
      retryConfig.maxDelayMs,
      retryConfig.baseDelayMs * Math.pow(2, attempt - 1)
    );
    await delay(backoffMs);
  }

  throw buildOrderNotReadyError(orderGid, retryConfig.maxAttempts);
}

/**
 * Mark an order as paid in Shopify
 * @param {string} orderGid Shopify order GID
 * @returns {Promise<{success: boolean, order: Object}>}
 */
async function markOrderAsPaid(orderGid) {
  const { shop, token } = await getShopAndToken();

  const mutation = `
    mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
      orderMarkAsPaid(input: $input) {
        order {
          id
          name
          displayFinancialStatus
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const response = await fetch(`https://${shop}/admin/api/2025-07/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: mutation,
      variables: {
        input: {
          id: orderGid,
        },
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify API error ${response.status}: ${text}`);
  }

  const json = await response.json();
  if (json.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  }

  const result = json.data?.orderMarkAsPaid;
  if (result?.userErrors?.length > 0) {
    throw new Error(`Shopify user errors: ${JSON.stringify(result.userErrors)}`);
  }

  return {
    success: true,
    order: result?.order,
  };
}

/**
 * Verify Shopify webhook HMAC signature
 * @param {string} rawBody Raw request body
 * @param {string} hmacHeader HMAC from X-Shopify-Hmac-Sha256 header
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, hmacHeader) {
  const crypto = require("crypto");
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

  if (!secret) {
    console.warn("SHOPIFY_WEBHOOK_SECRET not set, skipping verification");
    return true;
  }

  const hash = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  return crypto.timingSafeEqual(
    Buffer.from(hash),
    Buffer.from(hmacHeader)
  );
}

module.exports = {
  getOrder,
  markOrderAsPaid,
  isOrderNotReadyError,
  verifyWebhookSignature,
};
