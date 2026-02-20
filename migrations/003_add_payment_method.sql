-- Add payment_method column to distinguish EXPRESS vs REFERENCE flows

ALTER TABLE multicaixa_payments
ADD COLUMN payment_method TEXT DEFAULT 'EXPRESS';

-- Composite index for order + method lookups
CREATE INDEX IF NOT EXISTS idx_payments_order_method
ON multicaixa_payments(shopify_order_gid, payment_method);
