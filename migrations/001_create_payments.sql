-- Multicaixa payments table
-- Stores payment sessions created for orders

CREATE TABLE IF NOT EXISTS multicaixa_payments (
  id TEXT PRIMARY KEY,
  shopify_order_gid TEXT NOT NULL,
  order_number TEXT,
  reference TEXT UNIQUE NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT DEFAULT 'AOA',
  purchase_token TEXT,
  status TEXT DEFAULT 'CREATED',
  callback_payload_hash TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  paid_at TEXT,
  expires_at TEXT
);

-- Index for looking up payments by order
CREATE INDEX IF NOT EXISTS idx_payments_order_gid ON multicaixa_payments(shopify_order_gid);

-- Index for looking up payments by reference (used in callbacks)
CREATE INDEX IF NOT EXISTS idx_payments_reference ON multicaixa_payments(reference);

-- Index for looking up payments by status
CREATE INDEX IF NOT EXISTS idx_payments_status ON multicaixa_payments(status);
