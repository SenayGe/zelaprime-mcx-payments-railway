import {
  reactExtension,
  BlockStack,
  View,
  Heading,
  Text,
  Button,
  Link,
  useApi,
  useSubscription,
  useOrder,
  Spinner,
  Icon,
  InlineStack,
} from "@shopify/ui-extensions-react/checkout";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ====== EXPORTS (Thank You + Order Status blocks) ======
const thankYouBlock = reactExtension("purchase.thank-you.block.render", () => (
  <MCXThankYou />
));
export { thankYouBlock };

const orderDetailsBlock = reactExtension(
  "customer-account.order-status.block.render",
  () => <MCXOrderStatus />
);
export { orderDetailsBlock };

// ====== CONFIG ======
const BACKEND_URL = "https://zelaprime-mcx-payments-railway-production.up.railway.app";
const REFERENCE_EXPIRY_HOURS = 2;
const ORDER_FETCH_TIMEOUT_MS = 30_000;
const ORDER_FETCH_BASE_DELAY_MS = 500;
const ORDER_FETCH_MAX_DELAY_MS = 4_000;
const ORDER_NOT_READY_CODE = "ORDER_NOT_READY";
const ORDER_FETCH_FAILED_MESSAGE = "Falha ao obter dados da encomenda. Tente novamente.";
const PAYMENT_METHOD_TYPES = {
  EXPRESS: "EXPRESS",
  REFERENCE: "REFERENCE",
  OTHER: "OTHER",
};

// ====== THANK YOU PAGE ======
function MCXThankYou() {
  const { orderConfirmation } = useApi();
  const confirmation = useSubscription(orderConfirmation);
  const orderGid = useMemo(
    () => resolveOrderGid(confirmation?.order?.id),
    [confirmation?.order?.id]
  );

  return <MCXPaymentPanel orderGid={orderGid} waitForOrderId />;
}

// ====== ORDER STATUS PAGE ======
function MCXOrderStatus() {
  const order = useOrder();
  const orderGid = useMemo(() => resolveOrderGid(order?.id), [order?.id]);

  return (
    <MCXPaymentPanel
      orderGid={orderGid}
      missingOrderMessage="Não foi possível identificar esta encomenda. Atualize a página ou abra o link de estado da encomenda enviado por email."
    />
  );
}

// ====== Shared UI ======
function MCXPaymentPanel({ orderGid, waitForOrderId = false, missingOrderMessage }) {
  const {
    loading,
    error,
    orderData,
    paymentStatus,
    paymentMode,
    creatingSession,
    creatingReference,
    paymentUrl,
    referenceData,
    isReferenceFallback,
    handlePayClick,
    retryOrderFetch,
    formattedAmount,
  } = useMulticaixaPayment(orderGid, {
    waitForOrderId,
    missingOrderMessage,
  });

  if (loading) {
    return (
      <Card>
        <BlockStack spacing="tight">
          <Heading>Pagamento</Heading>
          <InlineStack spacing="tight" blockAlignment="center">
            <Spinner size="small" />
            <Text>A obter dados da encomenda...</Text>
          </InlineStack>
        </BlockStack>
      </Card>
    );
  }

  if (error && !orderData) {
    return (
      <Card>
        <BlockStack spacing="tight">
          <Heading>Pagamento</Heading>
          <Text>{error}</Text>
          <Button kind="secondary" onPress={retryOrderFetch}>
            Tentar novamente
          </Button>
        </BlockStack>
      </Card>
    );
  }

  if (paymentStatus === "PAID") {
    return (
      <Card appearance="success">
        <BlockStack spacing="tight">
          <InlineStack spacing="tight" blockAlignment="center">
            <Icon source="checkmark" appearance="accent" />
            <Heading>Pagamento Confirmado</Heading>
          </InlineStack>
          <Text>Obrigado pelo seu pagamento!</Text>
          {orderData?.name && (
            <Text size="small" appearance="subdued">
              Pedido {orderData.name}
            </Text>
          )}
        </BlockStack>
      </Card>
    );
  }

  if (paymentMode === PAYMENT_METHOD_TYPES.OTHER) {
    return null;
  }

  if (paymentMode === PAYMENT_METHOD_TYPES.REFERENCE && !isReferenceFallback) {
    return (
      <ReferencePaymentCard
        creatingReference={creatingReference}
        error={error}
        formattedAmount={formattedAmount}
        referenceData={referenceData}
      />
    );
  }

  return (
    <ExpressPaymentCard
      creatingSession={creatingSession}
      error={error}
      formattedAmount={formattedAmount}
      handlePayClick={handlePayClick}
      paymentUrl={paymentUrl}
      fallbackNotice={
        isReferenceFallback
          ? "A referência expirou. Pode concluir o pagamento com Multicaixa Express."
          : null
      }
    />
  );
}

function ExpressPaymentCard({
  creatingSession,
  error,
  formattedAmount,
  handlePayClick,
  paymentUrl,
  fallbackNotice,
}) {
  return (
    <Card>
      <BlockStack spacing="base">
        <Heading>Pagamento por Multicaixa</Heading>

        {fallbackNotice && (
          <View padding="tight" background="subdued" borderRadius="base">
            <Text size="small">{fallbackNotice}</Text>
          </View>
        )}

        {formattedAmount && (
          <BlockStack spacing="extraTight">
            <Text size="small" appearance="subdued">
              Montante a pagar
            </Text>
            <Text size="large" emphasis="bold">
              {formattedAmount}
            </Text>
          </BlockStack>
        )}

        {error && (
          <View padding="tight" background="subdued" borderRadius="base">
            <Text size="small">{error}</Text>
          </View>
        )}

        <Button
          kind="primary"
          onPress={!paymentUrl ? handlePayClick : undefined}
          to={paymentUrl || undefined}
          disabled={creatingSession}
          loading={creatingSession}
        >
          {creatingSession ? "A preparar pagamento..." : "Pagar com Multicaixa"}
        </Button>

        {paymentUrl && (
          <Text size="small" appearance="subdued">
            Se não abrir automaticamente,{" "}
            <Link to={paymentUrl} external>
              clique aqui
            </Link>
            .
          </Text>
        )}

        <Text size="small" appearance="subdued">
          Será redirecionado para a página de pagamento seguro.
        </Text>
      </BlockStack>
    </Card>
  );
}

function ReferencePaymentCard({
  creatingReference,
  error,
  formattedAmount,
  referenceData,
}) {
  return (
    <Card>
      <BlockStack spacing="base">
        <Heading>Pagamento por Referência</Heading>

        {formattedAmount && (
          <BlockStack spacing="extraTight">
            <Text size="small" appearance="subdued">
              Montante a pagar
            </Text>
            <Text size="large" emphasis="bold">
              {formattedAmount}
            </Text>
          </BlockStack>
        )}

        {!referenceData?.reference && creatingReference && (
          <InlineStack spacing="tight" blockAlignment="center">
            <Spinner size="small" />
            <Text>A gerar referência de pagamento...</Text>
          </InlineStack>
        )}

        {referenceData?.reference && (
          <BlockStack spacing="tight">
            <Text size="small" appearance="subdued">
              Referência
            </Text>
            <Text size="large" emphasis="bold">
              {referenceData.reference}
            </Text>
            <Text size="small" appearance="subdued">
              Use esta referência num ATM/Multicaixa e conclua o pagamento até{" "}
              {REFERENCE_EXPIRY_HOURS} horas após a criação da encomenda.
            </Text>
            {referenceData.expiresAt && (
              <Text size="small" appearance="subdued">
                Expira em {formatDateTime(referenceData.expiresAt)}.
              </Text>
            )}
          </BlockStack>
        )}

        {error && (
          <View padding="tight" background="subdued" borderRadius="base">
            <Text size="small">{error}</Text>
          </View>
        )}
      </BlockStack>
    </Card>
  );
}

// ====== Shared payment state ======
function useMulticaixaPayment(orderGid, { waitForOrderId = false, missingOrderMessage } = {}) {
  const [loading, setLoading] = useState(waitForOrderId || Boolean(orderGid));
  const [error, setError] = useState(null);
  const [orderData, setOrderData] = useState(null);
  const [orderReloadToken, setOrderReloadToken] = useState(0);
  const [paymentStatus, setPaymentStatus] = useState("PENDING");
  const [paymentMode, setPaymentMode] = useState(PAYMENT_METHOD_TYPES.EXPRESS);
  const [creatingSession, setCreatingSession] = useState(false);
  const [creatingReference, setCreatingReference] = useState(false);
  const [paymentUrl, setPaymentUrl] = useState(null);
  const [referenceData, setReferenceData] = useState(null);
  const autoSessionRequestedRef = useRef(false);
  const autoReferenceRequestedRef = useRef(false);
  const retryOrderFetch = useCallback(() => {
    autoSessionRequestedRef.current = false;
    autoReferenceRequestedRef.current = false;
    setLoading(true);
    setError(null);
    setOrderData(null);
    setPaymentUrl(null);
    setReferenceData(null);
    setPaymentStatus("PENDING");
    setOrderReloadToken((value) => value + 1);
  }, []);

  useEffect(() => {
    let live = true;

    async function fetchOrder() {
      if (!orderGid) {
        autoSessionRequestedRef.current = false;
        autoReferenceRequestedRef.current = false;
        setOrderData(null);
        setPaymentUrl(null);
        setReferenceData(null);
        setPaymentStatus("PENDING");
        setPaymentMode(PAYMENT_METHOD_TYPES.EXPRESS);

        if (waitForOrderId) {
          setError(null);
          setLoading(true);
        } else {
          setLoading(false);
          setError(
            missingOrderMessage ||
              "Não foi possível identificar a encomenda para iniciar o pagamento."
          );
        }
        return;
      }

      try {
        setLoading(true);
        setError(null);

        const json = await fetchOrderWithRetry(orderGid);
        if (!live) return;

        const resolvedMode = normalizePaymentMethodType(json.paymentMethodType);
        autoSessionRequestedRef.current = false;
        autoReferenceRequestedRef.current = false;
        setOrderData({
          gid: orderGid,
          name: json.orderName,
          amount: json.amount,
          currency: json.currencyCode,
          financialStatus: json.financialStatus,
          createdAt: json.createdAt || null,
          paymentMethodType: resolvedMode,
        });
        setPaymentMode(resolvedMode);
        setPaymentUrl(null);
        setReferenceData(null);
        setPaymentStatus(
          isPaidFinancialStatus(json.financialStatus) ? "PAID" : "PENDING"
        );
      } catch {
        if (!live) return;
        setOrderData(null);
        setError(ORDER_FETCH_FAILED_MESSAGE);
      } finally {
        if (live) setLoading(false);
      }
    }

    fetchOrder();
    return () => {
      live = false;
    };
  }, [missingOrderMessage, orderGid, orderReloadToken, waitForOrderId]);

  useEffect(() => {
    if (!orderData?.gid || paymentStatus === "PAID") return;

    let live = true;
    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(
          `${BACKEND_URL}/api/order-total?orderId=${encodeURIComponent(orderData.gid)}`,
          { method: "GET" }
        );
        if (!res.ok) return;
        const json = await res.json();
        if (!live) return;

        if (isPaidFinancialStatus(json.financialStatus)) {
          setPaymentStatus("PAID");
        }

        const resolvedMode = normalizePaymentMethodType(json.paymentMethodType);
        setPaymentMode(resolvedMode);
        setOrderData((current) =>
          current
            ? {
                ...current,
                amount: json.amount ?? current.amount,
                currency: json.currencyCode ?? current.currency,
                financialStatus: json.financialStatus ?? current.financialStatus,
                createdAt: json.createdAt || current.createdAt,
                paymentMethodType: resolvedMode,
              }
            : current
        );

        if (
          resolvedMode !== PAYMENT_METHOD_TYPES.REFERENCE &&
          referenceData
        ) {
          setReferenceData(null);
          autoReferenceRequestedRef.current = false;
        }
      } catch {
        // Ignore polling errors
      }
    }, 5000);

    return () => {
      live = false;
      clearInterval(pollInterval);
    };
  }, [orderData?.gid, paymentStatus, referenceData]);

  useEffect(() => {
    if (!referenceData?.expiresAt || referenceData.isExpired) return;

    const timer = setInterval(() => {
      if (isExpired(referenceData.expiresAt)) {
        setReferenceData((current) =>
          current ? { ...current, isExpired: true } : current
        );
      }
    }, 15000);

    return () => clearInterval(timer);
  }, [referenceData]);

  const formattedAmount = useMemo(() => {
    if (!orderData?.amount || !orderData?.currency) return null;
    try {
      return new Intl.NumberFormat("pt-AO", {
        style: "currency",
        currency: orderData.currency,
      }).format(Number(orderData.amount));
    } catch {
      return `${orderData.amount} ${orderData.currency}`;
    }
  }, [orderData?.amount, orderData?.currency]);

  const createPaymentSession = useCallback(async () => {
    if (!orderData?.gid) return null;
    if (paymentUrl) return paymentUrl;
    if (creatingSession) return null;

    setCreatingSession(true);
    setError(null);

    try {
      const res = await fetch(`${BACKEND_URL}/api/mcx/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: orderData.gid }),
      });

      if (!res.ok) {
        const message = await readErrorMessage(
          res,
          "Falha ao criar sessão de pagamento."
        );
        throw new Error(message);
      }

      const body = await res.json();
      if (!body?.paymentUrl) {
        throw new Error("Falha ao criar sessão de pagamento.");
      }

      setPaymentUrl(body.paymentUrl);
      return body.paymentUrl;
    } catch (e) {
      setError(e?.message || "Falha ao criar sessão de pagamento.");
      return null;
    } finally {
      setCreatingSession(false);
    }
  }, [creatingSession, orderData?.gid, paymentUrl]);

  const createReferenceSession = useCallback(async () => {
    if (!orderData?.gid) return null;
    if (creatingReference) return null;
    if (referenceData?.reference || referenceData?.isExpired) return referenceData;

    setCreatingReference(true);
    setError(null);

    try {
      const res = await fetch(`${BACKEND_URL}/api/mcx/sessions/reference`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: orderData.gid }),
      });

      if (!res.ok) {
        const message = await readErrorMessage(
          res,
          "Falha ao gerar referência de pagamento."
        );
        throw new Error(message);
      }

      const body = await res.json();
      if (
        !body ||
        typeof body !== "object" ||
        typeof body.isExpired !== "boolean"
      ) {
        throw new Error("Falha ao gerar referência de pagamento.");
      }

      const nextReferenceData = {
        reference: body.reference || null,
        amount: body.amount || orderData.amount || null,
        currencyCode: body.currencyCode || orderData.currency || null,
        expiresAt: body.expiresAt || null,
        isExpired: Boolean(body.isExpired),
      };

      setReferenceData(nextReferenceData);
      return nextReferenceData;
    } catch (e) {
      setError(e?.message || "Falha ao gerar referência de pagamento.");
      return null;
    } finally {
      setCreatingReference(false);
    }
  }, [creatingReference, orderData?.gid, orderData?.amount, orderData?.currency, referenceData]);

  const isReferenceFallback = useMemo(
    () =>
      paymentMode === PAYMENT_METHOD_TYPES.REFERENCE &&
      Boolean(referenceData?.isExpired),
    [paymentMode, referenceData?.isExpired]
  );

  const shouldShowExpressFlow = useMemo(
    () =>
      paymentMode === PAYMENT_METHOD_TYPES.EXPRESS || isReferenceFallback,
    [isReferenceFallback, paymentMode]
  );

  useEffect(() => {
    if (!orderData?.gid) return;
    if (paymentStatus === "PAID") return;
    if (paymentMode !== PAYMENT_METHOD_TYPES.REFERENCE) return;
    if (referenceData?.reference || referenceData?.isExpired) return;
    if (autoReferenceRequestedRef.current) return;

    autoReferenceRequestedRef.current = true;
    createReferenceSession();
  }, [
    createReferenceSession,
    orderData?.gid,
    paymentMode,
    paymentStatus,
    referenceData?.isExpired,
    referenceData?.reference,
  ]);

  useEffect(() => {
    if (!orderData?.gid) return;
    if (paymentStatus === "PAID") return;
    if (!shouldShowExpressFlow) return;
    if (paymentUrl) return;
    if (autoSessionRequestedRef.current) return;

    autoSessionRequestedRef.current = true;
    createPaymentSession();
  }, [
    createPaymentSession,
    orderData?.gid,
    paymentStatus,
    paymentUrl,
    shouldShowExpressFlow,
  ]);

  const handlePayClick = useCallback(async () => {
    if (paymentUrl) return;
    await createPaymentSession();
  }, [createPaymentSession, paymentUrl]);

  return {
    loading,
    error,
    orderData,
    paymentStatus,
    paymentMode,
    creatingSession,
    creatingReference,
    paymentUrl,
    referenceData,
    isReferenceFallback,
    handlePayClick,
    retryOrderFetch,
    formattedAmount,
  };
}

// ====== Helpers ======
function Card({ children, appearance }) {
  const background = appearance === "success" ? "subdued" : undefined;
  return (
    <View border="base" padding="base" borderRadius="base" background={background}>
      {children}
    </View>
  );
}

function resolveOrderGid(rawOrderId) {
  if (!rawOrderId) return null;

  const raw = String(rawOrderId);
  if (raw.startsWith("gid://shopify/Order/")) {
    return raw;
  }

  const tail = raw.split("/").pop();
  if (tail && /^\d+$/.test(tail)) {
    return `gid://shopify/Order/${tail}`;
  }

  return /^\d+$/.test(raw) ? `gid://shopify/Order/${raw}` : null;
}

function isPaidFinancialStatus(financialStatus) {
  return financialStatus === "PAID" || financialStatus === "PARTIALLY_PAID";
}

function normalizePaymentMethodType(paymentMethodType) {
  if (paymentMethodType === PAYMENT_METHOD_TYPES.REFERENCE) {
    return PAYMENT_METHOD_TYPES.REFERENCE;
  }
  if (paymentMethodType === PAYMENT_METHOD_TYPES.OTHER) {
    return PAYMENT_METHOD_TYPES.OTHER;
  }
  return PAYMENT_METHOD_TYPES.EXPRESS;
}

function isExpired(timestamp) {
  const ts = Date.parse(String(timestamp || ""));
  return Number.isFinite(ts) ? Date.now() >= ts : false;
}

function formatDateTime(timestamp) {
  const ts = Date.parse(String(timestamp || ""));
  if (!Number.isFinite(ts)) return String(timestamp || "");

  try {
    return new Intl.DateTimeFormat("pt-AO", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString();
  }
}

async function fetchOrderWithRetry(orderGid) {
  const startedAt = Date.now();
  let attempt = 0;
  while (Date.now() - startedAt < ORDER_FETCH_TIMEOUT_MS) {
    attempt += 1;
    const res = await fetch(
      `${BACKEND_URL}/api/order-total?orderId=${encodeURIComponent(orderGid)}`,
      { method: "GET" }
    );

    if (res.ok) {
      return res.json();
    }

    const errorDetails = await readErrorDetails(res);
    if (!isRetryableOrderFetchFailure(res.status, errorDetails)) {
      throw new Error(ORDER_FETCH_FAILED_MESSAGE);
    }

    const delayMs = getOrderFetchRetryDelayMs(attempt);
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs + delayMs >= ORDER_FETCH_TIMEOUT_MS) {
      break;
    }
    await delay(delayMs);
  }

  throw new Error(ORDER_FETCH_FAILED_MESSAGE);
}

async function readErrorDetails(response) {
  let code = null;
  let retryable = false;
  let message = "";
  const clone = response.clone();

  try {
    const body = await response.json();
    if (body && typeof body === "object") {
      if (typeof body.code === "string") {
        code = body.code;
      }
      if (typeof body.retryable === "boolean") {
        retryable = body.retryable;
      }
      if (typeof body.error === "string") {
        message = body.error;
      } else if (typeof body.message === "string") {
        message = body.message;
      }
    }
  } catch {
    try {
      message = (await clone.text()).trim();
    } catch {
      message = "";
    }
  }

  return {
    code,
    retryable,
    message,
  };
}

function isRetryableOrderFetchFailure(status, errorDetails) {
  if (status === 404) return true;
  if (status >= 500 && status <= 599) return true;

  if (
    status === 409 &&
    (errorDetails.code === ORDER_NOT_READY_CODE || errorDetails.retryable === true)
  ) {
    return true;
  }

  const normalizedMessage = String(errorDetails.message || "").toLowerCase();
  return (
    normalizedMessage.includes("order not found") ||
    normalizedMessage.includes("order not ready")
  );
}

function getOrderFetchRetryDelayMs(attempt) {
  return Math.min(
    ORDER_FETCH_MAX_DELAY_MS,
    ORDER_FETCH_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1))
  );
}

async function readErrorMessage(response, fallbackMessage) {
  try {
    const body = await response.json();
    if (body?.error) return body.error;
  } catch {
    // Fall back to text response.
  }

  try {
    const text = await response.text();
    if (text) return text;
  } catch {
    // Ignore parsing failure.
  }

  return fallbackMessage;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
