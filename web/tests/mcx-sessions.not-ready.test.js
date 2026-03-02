const test = require("node:test");
const assert = require("node:assert/strict");
const routerPath = require.resolve("../routes/mcx-sessions");
const paymentServicePath = require.resolve("../services/payment-service");

function loadRouterWithPaymentServiceMocks(overrides = {}) {
  const previousCache = new Map([
    [routerPath, require.cache[routerPath]],
    [paymentServicePath, require.cache[paymentServicePath]],
  ]);

  delete require.cache[routerPath];
  delete require.cache[paymentServicePath];

  require.cache[paymentServicePath] = {
    id: paymentServicePath,
    filename: paymentServicePath,
    loaded: true,
    exports: {
      createPaymentSession: async () => ({
        paymentId: "test-id",
        paymentUrl: "https://example.test/pay/test-id",
        expiresAt: "2026-03-02T12:00:00.000Z",
      }),
      createOrGetReferencePayment: async () => ({
        reference: "123456789",
        amount: "200.00",
        currencyCode: "AOA",
        expiresAt: "2026-03-02T12:00:00.000Z",
        isExpired: false,
      }),
      getPaymentSession: async () => ({
        id: "test-id",
        status: "CREATED",
        order_number: "#100",
        paid_at: null,
      }),
      getPaymentStatusByOrder: async () => ({
        status: "NONE",
        paymentId: null,
      }),
      ...overrides,
    },
  };

  const router = require(routerPath);

  return {
    router,
    restore() {
      delete require.cache[routerPath];
      delete require.cache[paymentServicePath];

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

function createRetryableOrderNotReadyError() {
  const err = new Error("Order not ready yet");
  err.code = "ORDER_NOT_READY";
  err.retryable = true;
  return err;
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
  };

  return response;
}

test("POST /api/mcx/sessions returns 409 ORDER_NOT_READY contract", async () => {
  const { router, restore } = loadRouterWithPaymentServiceMocks({
    createPaymentSession: async () => {
      throw createRetryableOrderNotReadyError();
    },
  });

  try {
    const handler = getRouteHandler(router, "post", "/");
    const req = {
      body: { orderId: "gid://shopify/Order/200" },
      ip: "127.0.0.1",
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

test("POST /api/mcx/sessions/reference returns 409 ORDER_NOT_READY contract", async () => {
  const { router, restore } = loadRouterWithPaymentServiceMocks({
    createOrGetReferencePayment: async () => {
      throw createRetryableOrderNotReadyError();
    },
  });

  try {
    const handler = getRouteHandler(router, "post", "/reference");
    const req = {
      body: { orderId: "gid://shopify/Order/201" },
      ip: "127.0.0.1",
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
