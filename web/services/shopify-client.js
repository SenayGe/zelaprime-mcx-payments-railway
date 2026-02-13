// web/services/shopify-client.js
// Shopify Admin API client for order operations

const tokenStore = require("./shopify-token-store");

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

/**
 * Get order details from Shopify Admin API
 * @param {string} orderGid Shopify order GID (e.g., "gid://shopify/Order/123")
 * @returns {Promise<{id: string, name: string, amount: string, currency: string, financialStatus: string, statusPageUrl?: string}>}
 */
async function getOrder(orderGid) {
  const { shop, token } = await getShopAndToken();

  const query = `
    query ($id: ID!) {
      order(id: $id) {
        id
        name
        statusPageUrl
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

  const order = json.data?.order;
  if (!order) {
    throw new Error("Order not found");
  }

  const money = order.currentTotalPriceSet?.shopMoney || order.totalPriceSet?.shopMoney;

  return {
    id: order.id,
    name: order.name,
    amount: money?.amount,
    currency: money?.currencyCode,
    financialStatus: order.displayFinancialStatus,
    statusPageUrl: order.statusPageUrl,
  };
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
  verifyWebhookSignature,
};
