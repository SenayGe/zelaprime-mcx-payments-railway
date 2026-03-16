const test = require("node:test");
const assert = require("node:assert/strict");

const shopifyClientPath = require.resolve("../services/shopify-client");

function loadFreshShopifyClient() {
  delete require.cache[shopifyClientPath];
  return require("../services/shopify-client");
}

async function withEnv(overrides, fn) {
  const previous = {};

  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : null;
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function buildGraphQlOrder(orderId) {
  return {
    id: orderId,
    name: "#1001",
    createdAt: "2026-03-02T10:00:00.000Z",
    statusPageUrl: "https://store.example/orders/1001",
    paymentGatewayNames: ["MULTICAIXA Express"],
    displayFinancialStatus: "PENDING",
    currentTotalPriceSet: {
      shopMoney: {
        amount: "250.00",
        currencyCode: "AOA",
      },
    },
    totalPriceSet: {
      shopMoney: {
        amount: "250.00",
        currencyCode: "AOA",
      },
    },
  };
}

test("getOrder retries transient null order responses and returns order data", async () => {
  await withEnv(
    {
      SHOPIFY_SHOP: "example.myshopify.com",
      SHOPIFY_ADMIN_TOKEN: "test-admin-token",
      SHOPIFY_ORDER_LOOKUP_MAX_ATTEMPTS: "4",
      SHOPIFY_ORDER_LOOKUP_BASE_DELAY_MS: "1",
      SHOPIFY_ORDER_LOOKUP_MAX_DELAY_MS: "1",
    },
    async () => {
      const previousFetch = global.fetch;
      let callCount = 0;

      global.fetch = async () => {
        callCount += 1;

        if (callCount < 3) {
          return {
            ok: true,
            json: async () => ({ data: { order: null } }),
          };
        }

        return {
          ok: true,
          json: async () => ({
            data: {
              order: buildGraphQlOrder("gid://shopify/Order/123"),
            },
          }),
        };
      };

      try {
        const shopifyClient = loadFreshShopifyClient();
        const order = await shopifyClient.getOrder("gid://shopify/Order/123");

        assert.equal(callCount, 3);
        assert.equal(order.id, "gid://shopify/Order/123");
        assert.equal(order.name, "#1001");
        assert.equal(order.amount, "250.00");
        assert.equal(order.currency, "AOA");
        assert.equal(order.financialStatus, "PENDING");
      } finally {
        global.fetch = previousFetch;
      }
    }
  );
});

test("getOrder requests the customer-view web status page URL", async () => {
  await withEnv(
    {
      SHOPIFY_SHOP: "example.myshopify.com",
      SHOPIFY_ADMIN_TOKEN: "test-admin-token",
      SHOPIFY_ORDER_LOOKUP_MAX_ATTEMPTS: "1",
      SHOPIFY_ORDER_LOOKUP_BASE_DELAY_MS: "1",
      SHOPIFY_ORDER_LOOKUP_MAX_DELAY_MS: "1",
    },
    async () => {
      const previousFetch = global.fetch;
      let capturedQuery = "";

      global.fetch = async (_url, options = {}) => {
        const payload = JSON.parse(String(options.body || "{}"));
        capturedQuery = String(payload.query || "");

        return {
          ok: true,
          json: async () => ({
            data: {
              order: buildGraphQlOrder("gid://shopify/Order/321"),
            },
          }),
        };
      };

      try {
        const shopifyClient = loadFreshShopifyClient();
        await shopifyClient.getOrder("gid://shopify/Order/321");

        assert.match(
          capturedQuery,
          /statusPageUrl\(audience:\s*CUSTOMERVIEW,\s*notificationUsage:\s*WEB\)/
        );
      } finally {
        global.fetch = previousFetch;
      }
    }
  );
});

test("getOrder throws tagged ORDER_NOT_READY after max attempts", async () => {
  await withEnv(
    {
      SHOPIFY_SHOP: "example.myshopify.com",
      SHOPIFY_ADMIN_TOKEN: "test-admin-token",
      SHOPIFY_ORDER_LOOKUP_MAX_ATTEMPTS: "3",
      SHOPIFY_ORDER_LOOKUP_BASE_DELAY_MS: "1",
      SHOPIFY_ORDER_LOOKUP_MAX_DELAY_MS: "1",
    },
    async () => {
      const previousFetch = global.fetch;
      let callCount = 0;

      global.fetch = async () => {
        callCount += 1;
        return {
          ok: true,
          json: async () => ({ data: { order: null } }),
        };
      };

      try {
        const shopifyClient = loadFreshShopifyClient();

        await assert.rejects(
          () => shopifyClient.getOrder("gid://shopify/Order/999"),
          (err) => {
            assert.equal(err.message, "Order not ready yet");
            assert.equal(err.code, "ORDER_NOT_READY");
            assert.equal(err.retryable, true);
            assert.equal(err.attempts, 3);
            return true;
          }
        );
        assert.equal(callCount, 3);
      } finally {
        global.fetch = previousFetch;
      }
    }
  );
});
