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
    creatingSession,
    paymentUrl,
    handlePayClick,
    formattedAmount,
  } = useMulticaixaPayment(orderGid, {
    waitForOrderId,
    missingOrderMessage,
  });

  if (loading) {
    return (
      <Card>
        <BlockStack spacing="tight">
          <Heading>Pagamento por Multicaixa</Heading>
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
          <Heading>Pagamento por Multicaixa</Heading>
          <Text>{error}</Text>
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

  return (
    <Card>
      <BlockStack spacing="base">
        <Heading>Pagamento por Multicaixa</Heading>

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
          disabled={creatingSession || (!paymentUrl && !orderData?.gid)}
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

// ====== Shared payment state ======
function useMulticaixaPayment(orderGid, { waitForOrderId = false, missingOrderMessage } = {}) {
  const [loading, setLoading] = useState(waitForOrderId || Boolean(orderGid));
  const [error, setError] = useState(null);
  const [orderData, setOrderData] = useState(null);
  const [paymentStatus, setPaymentStatus] = useState("PENDING");
  const [creatingSession, setCreatingSession] = useState(false);
  const [paymentUrl, setPaymentUrl] = useState(null);
  const autoSessionRequestedRef = useRef(false);

  useEffect(() => {
    let live = true;

    async function fetchOrder() {
      if (!orderGid) {
        autoSessionRequestedRef.current = false;
        setOrderData(null);
        setPaymentUrl(null);
        setPaymentStatus("PENDING");

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

        autoSessionRequestedRef.current = false;
        setOrderData({
          gid: orderGid,
          name: json.orderName,
          amount: json.amount,
          currency: json.currencyCode,
          financialStatus: json.financialStatus,
        });
        setPaymentUrl(null);
        setPaymentStatus(
          isPaidFinancialStatus(json.financialStatus) ? "PAID" : "PENDING"
        );
      } catch {
        if (!live) return;
        setOrderData(null);
        setError("Falha ao obter dados da encomenda.");
      } finally {
        if (live) setLoading(false);
      }
    }

    fetchOrder();
    return () => {
      live = false;
    };
  }, [missingOrderMessage, orderGid, waitForOrderId]);

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
      } catch {
        // Ignore polling errors
      }
    }, 5000);

    return () => {
      live = false;
      clearInterval(pollInterval);
    };
  }, [orderData?.gid, paymentStatus]);

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

  useEffect(() => {
    if (!orderData?.gid) return;
    if (paymentStatus === "PAID") return;
    if (paymentUrl) return;
    if (autoSessionRequestedRef.current) return;

    autoSessionRequestedRef.current = true;
    createPaymentSession();
  }, [createPaymentSession, orderData?.gid, paymentStatus, paymentUrl]);

  const handlePayClick = useCallback(async () => {
    if (paymentUrl) return;
    await createPaymentSession();
  }, [createPaymentSession, paymentUrl]);

  return {
    loading,
    error,
    orderData,
    paymentStatus,
    creatingSession,
    paymentUrl,
    handlePayClick,
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

async function fetchOrderWithRetry(orderGid) {
  const MAX_RETRIES = 6;
  let attempt = 0;
  let orderJson = null;

  while (attempt <= MAX_RETRIES) {
    const res = await fetch(
      `${BACKEND_URL}/api/order-total?orderId=${encodeURIComponent(orderGid)}`,
      { method: "GET" }
    );

    if (res.ok) {
      orderJson = await res.json();
      break;
    }

    let errorText = "";
    try {
      errorText = await res.text();
    } catch {
      errorText = "";
    }

    const looksLikeOrderNotReady =
      res.status === 404 ||
      errorText.includes("Order not found") ||
      errorText.includes("order not found");

    if (looksLikeOrderNotReady && attempt < MAX_RETRIES) {
      await delay(500 * (attempt + 1));
      attempt += 1;
      continue;
    }

    throw new Error(`Backend ${res.status}${errorText ? `: ${errorText}` : ""}`);
  }

  if (!orderJson) {
    throw new Error("Failed to load order after retries");
  }

  return orderJson;
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
