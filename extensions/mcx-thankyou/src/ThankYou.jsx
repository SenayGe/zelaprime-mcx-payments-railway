import {
  reactExtension,
  BlockStack,
  View,
  Heading,
  Text,
  Button,
  Link,
  useStorage,
  useApi,
  useSubscription,
  Spinner,
  Icon,
  InlineStack,
} from "@shopify/ui-extensions-react/checkout";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BACKEND_URL } from "./config";

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

// ====== THANK YOU PAGE ======
function MCXThankYou() {
  const { orderConfirmation } = useApi();
  const confirmation = useSubscription(orderConfirmation);
  const orderId = confirmation?.order?.id;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [orderData, setOrderData] = useState(null);
  const [paymentStatus, setPaymentStatus] = useState("PENDING");
  const [creatingSession, setCreatingSession] = useState(false);
  const [paymentUrl, setPaymentUrl] = useState(null);
  const sessionRequestedRef = useRef(false);

  // Fetch order details
  useEffect(() => {
    let live = true;
    async function fetchOrder() {
      try {
        setLoading(true);
        setError(null);
        if (!orderId) {
          await delay(250);
        }
        if (!orderId) return;

        const numericalOrderId = orderId.split("/").pop();
        const adminApiGid = `gid://shopify/Order/${numericalOrderId}`;

        const MAX_RETRIES = 6;
        let attempt = 0;
        let json = null;

        while (attempt <= MAX_RETRIES) {
          const res = await fetch(
            `${BACKEND_URL}/api/order-total?orderId=${encodeURIComponent(adminApiGid)}`,
            { method: "GET" }
          );

          if (res.ok) {
            json = await res.json();
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

        if (!json) throw new Error("Failed to load order after retries");
        if (!live) return;

        setOrderData({
          gid: adminApiGid,
          name: json.orderName,
          amount: json.amount,
          currency: json.currencyCode,
          financialStatus: json.financialStatus,
        });
        setPaymentUrl(null);

        // Update payment status based on financial status
        if (json.financialStatus === "PAID" || json.financialStatus === "PARTIALLY_PAID") {
          setPaymentStatus("PAID");
        } else {
          setPaymentStatus("PENDING");
        }
      } catch (e) {
        if (live) setError("Falha ao obter dados da encomenda.");
      } finally {
        if (live) setLoading(false);
      }
    }
    fetchOrder();
    return () => {
      live = false;
    };
  }, [orderId]);

  // Poll for payment status changes
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

        if (json.financialStatus === "PAID" || json.financialStatus === "PARTIALLY_PAID") {
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

  // Format amount for display
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
    if (creatingSession) return paymentUrl;

    sessionRequestedRef.current = true;
    setCreatingSession(true);
    setError(null);

    try {
      const res = await fetch(`${BACKEND_URL}/api/mcx/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: orderData.gid }),
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || "Failed to create payment session");
      }

      const { paymentUrl: newPaymentUrl } = await res.json();
      setPaymentUrl(newPaymentUrl);
      return newPaymentUrl;
    } catch (e) {
      sessionRequestedRef.current = false;
      setError(e.message || "Falha ao criar sessão de pagamento.");
      return null;
    } finally {
      setCreatingSession(false);
    }
  }, [creatingSession, orderData?.gid, paymentUrl]);

  // Pre-create payment session once order is ready
  useEffect(() => {
    if (!orderData?.gid) return;
    if (paymentStatus === "PAID") return;
    if (paymentUrl) return;
    if (sessionRequestedRef.current) return;

    createPaymentSession();
  }, [createPaymentSession, orderData?.gid, paymentStatus, paymentUrl]);

  // Handle Pay button click
  const handlePayClick = useCallback(async () => {
    if (paymentUrl) return;
    await createPaymentSession();
  }, [createPaymentSession, paymentUrl]);

  // Show nothing while loading
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

  // Show error state
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

  // Show success state when paid
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

  // Show Pay button for unpaid orders
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
          disabled={creatingSession || !paymentUrl}
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

// ====== ORDER STATUS PAGE ======
function MCXOrderStatus() {
  const order = useOrderSafe();
  const [dismissed, setDismissed] = useStorageState("mcx-os-dismissed");

  if (dismissed.loading || dismissed.data === true) return null;

  return (
    <Card>
      <BlockStack spacing="tight">
        <Heading>Pagamento Multicaixa - Ajuda</Heading>
        {order?.name && <Mono label="Pedido" value={order.name} />}
        <Text>
          Se ainda não concluiu o pagamento, pode voltar à página de confirmação
          da encomenda para pagar. Após pagar, a confirmação é automática.
        </Text>
        <Button kind="secondary" onPress={() => setDismissed(true)}>
          Entendi
        </Button>
      </BlockStack>
    </Card>
  );
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

function Mono({ label, value }) {
  return (
    <Text>
      <Text emphasis>{label}:</Text> <Text appearance="monospace">{value}</Text>
    </Text>
  );
}

function useStorageState(key) {
  const storage = useStorage();
  const [data, setData] = useState();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    (async () => {
      const value = await storage.read(key);
      if (live) {
        setData(value);
        setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [storage, key]);

  const setStorage = useCallback(
    (value) => {
      storage.write(key, value);
    },
    [storage, key]
  );
  return [{ data, loading }, setStorage];
}

function useOrderSafe() {
  try {
    return require("@shopify/ui-extensions-react/checkout").useOrder?.();
  } catch {
    return undefined;
  }
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
