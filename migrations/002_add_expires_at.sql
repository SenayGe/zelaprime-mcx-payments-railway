-- Add expires_at column to multicaixa_payments

ALTER TABLE multicaixa_payments
ADD COLUMN expires_at TEXT;
