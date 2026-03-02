const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const appPath = require.resolve("../app");
const databasePath = require.resolve("../config/database");
const paymentServicePath = require.resolve("../services/payment-service");
const shopifyClientPath = require.resolve("../services/shopify-client");
const mcxSessionsRouterPath = require.resolve("../routes/mcx-sessions");
const mcxCallbackRouterPath = require.resolve("../routes/mcx-callback");
const shopifyWebhooksRouterPath = require.resolve("../routes/shopify-webhooks");
const shopifyAuthRouterPath = require.resolve("../routes/shopify-auth");

function createNoopRouter() {
  return express.Router();
}

function loadAppWithMocks({ getOrder }) {
  const previousCache = new Map([
    [appPath, require.cache[appPath]],
    [databasePath, require.cache[databasePath]],
    [paymentServicePath, require.cache[paymentServicePath]],
    [shopifyClientPath, require.cache[shopifyClientPath]],
    [mcxSessionsRouterPath, require.cache[mcxSessionsRouterPath]],
    [mcxCallbackRouterPath, require.cache[mcxCallbackRouterPath]],
    [shopifyWebhooksRouterPath, require.cache[shopifyWebhooksRouterPath]],
    [shopifyAuthRouterPath, require.cache[shopifyAuthRouterPath]],
  ]);

  delete require.cache[appPath];
  delete require.cache[databasePath];
  delete require.cache[paymentServicePath];
  delete require.cache[shopifyClientPath];
  delete require.cache[mcxSessionsRouterPath];
  delete require.cache[mcxCallbackRouterPath];
  delete require.cache[shopifyWebhooksRouterPath];
  delete require.cache[shopifyAuthRouterPath];

  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: {
      initDatabase: async () => {},
    },
  };

  require.cache[paymentServicePath] = {
    id: paymentServicePath,
    filename: paymentServicePath,
    loaded: true,
    exports: {
      getPaymentMethodType: () => "EXPRESS",
      hasConfirmedPaymentForOrder: async () => false,
    },
  };

  require.cache[shopifyClientPath] = {
    id: shopifyClientPath,
    filename: shopifyClientPath,
    loaded: true,
    exports: {
      getOrder,
      markOrderAsPaid: async () => {},
      isOrderNotReadyError: (err) =>
        err?.code === "ORDER_NOT_READY" && err?.retryable === true,
    },
  };

  require.cache[mcxSessionsRouterPath] = {
    id: mcxSessionsRouterPath,
    filename: mcxSessionsRouterPath,
    loaded: true,
    exports: createNoopRouter(),
  };
  require.cache[mcxCallbackRouterPath] = {
    id: mcxCallbackRouterPath,
    filename: mcxCallbackRouterPath,
    loaded: true,
    exports: createNoopRouter(),
  };
  require.cache[shopifyWebhooksRouterPath] = {
    id: shopifyWebhooksRouterPath,
    filename: shopifyWebhooksRouterPath,
    loaded: true,
    exports: createNoopRouter(),
  };
  require.cache[shopifyAuthRouterPath] = {
    id: shopifyAuthRouterPath,
    filename: shopifyAuthRouterPath,
    loaded: true,
    exports: createNoopRouter(),
  };

  const app = require(appPath);

  return {
    app,
    restore() {
      delete require.cache[appPath];
      delete require.cache[databasePath];
      delete require.cache[paymentServicePath];
      delete require.cache[shopifyClientPath];
      delete require.cache[mcxSessionsRouterPath];
      delete require.cache[mcxCallbackRouterPath];
      delete require.cache[shopifyWebhooksRouterPath];
      delete require.cache[shopifyAuthRouterPath];

      for (const [modulePath, cachedModule] of previousCache.entries()) {
        if (cachedModule) {
          require.cache[modulePath] = cachedModule;
        } else {
          delete require.cache[modulePath];
        }
      }
    },
  };
}

function getRouteHandler(router, method, path) {
  const normalizedMethod = String(method || "").toLowerCase();
  const layer = router.stack.find(
    (entry) =>
      entry.route &&
      entry.route.path === path &&
      entry.route.methods?.[normalizedMethod]
  );

  assert.ok(layer, `Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createMockResponse() {
  const response = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
  };

  return response;
}

test("GET /api/order-total returns 409 contract for retryable ORDER_NOT_READY", async () => {
  const retryableError = new Error("Order not ready yet");
  retryableError.code = "ORDER_NOT_READY";
  retryableError.retryable = true;

  const { app, restore } = loadAppWithMocks({
    getOrder: async () => {
      throw retryableError;
    },
  });

  try {
    const handler = getRouteHandler(app.router, "get", "/api/order-total");
    const req = {
      query: { orderId: "gid://shopify/Order/100" },
    };
    const res = createMockResponse();

    await handler(req, res);

    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.body, {
      error: "Order not ready yet",
      code: "ORDER_NOT_READY",
      retryable: true,
    });
  } finally {
    restore();
  }
});

test("GET /api/order-total preserves success payload for valid order", async () => {
  const { app, restore } = loadAppWithMocks({
    getOrder: async () => ({
      id: "gid://shopify/Order/101",
      name: "#101",
      amount: "500.00",
      currency: "AOA",
      financialStatus: "PENDING",
      createdAt: "2026-03-02T10:00:00.000Z",
      paymentGatewayNames: ["MULTICAIXA Express"],
    }),
  });

  try {
    const handler = getRouteHandler(app.router, "get", "/api/order-total");
    const req = {
      query: { orderId: "101" },
    };
    const res = createMockResponse();

    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.orderId, "gid://shopify/Order/101");
    assert.equal(res.body.orderName, "#101");
    assert.equal(res.body.amount, "500.00");
    assert.equal(res.body.currencyCode, "AOA");
    assert.equal(res.body.financialStatus, "PENDING");
    assert.equal(res.body.paymentMethodType, "EXPRESS");
    assert.deepEqual(res.body.paymentGatewayNames, ["MULTICAIXA Express"]);
  } finally {
    restore();
  }
});
