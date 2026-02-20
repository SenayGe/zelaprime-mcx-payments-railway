// web/config/database.js
// Turso SQLite client for storing payment sessions

const { createClient } = require("@libsql/client");

let db = null;

function getDatabase() {
  if (db) return db;

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) {
    throw new Error("Missing TURSO_DATABASE_URL environment variable");
  }

  db = createClient({
    url,
    authToken,
    rowMode: "object",
  });

  return db;
}

// Initialize database schema
async function initDatabase() {
  const client = getDatabase();

  await client.execute(`
    CREATE TABLE IF NOT EXISTS multicaixa_payments (
      id TEXT PRIMARY KEY,
      shopify_order_gid TEXT NOT NULL,
      order_number TEXT,
      reference TEXT UNIQUE NOT NULL,
      amount_minor INTEGER NOT NULL,
      currency TEXT DEFAULT 'AOA',
      purchase_token TEXT,
      status TEXT DEFAULT 'CREATED',
      payment_method TEXT DEFAULT 'EXPRESS',
      callback_payload_hash TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      paid_at TEXT,
      expires_at TEXT
    )
  `);

  const columns = await client.execute(`PRAGMA table_info(multicaixa_payments)`);
  const hasExpiresAt = columns.rows?.some((row) => row.name === "expires_at");
  if (!hasExpiresAt) {
    await client.execute(
      `ALTER TABLE multicaixa_payments ADD COLUMN expires_at TEXT`
    );
  }
  const hasPaymentMethod = columns.rows?.some(
    (row) => row.name === "payment_method"
  );
  if (!hasPaymentMethod) {
    await client.execute(
      `ALTER TABLE multicaixa_payments ADD COLUMN payment_method TEXT DEFAULT 'EXPRESS'`
    );
  }

  await client.execute(`
    CREATE INDEX IF NOT EXISTS idx_payments_order_gid ON multicaixa_payments(shopify_order_gid)
  `);

  await client.execute(`
    CREATE INDEX IF NOT EXISTS idx_payments_reference ON multicaixa_payments(reference)
  `);

  await client.execute(`
    CREATE INDEX IF NOT EXISTS idx_payments_status ON multicaixa_payments(status)
  `);

  await client.execute(`
    CREATE INDEX IF NOT EXISTS idx_payments_order_method ON multicaixa_payments(shopify_order_gid, payment_method)
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS shopify_tokens (
      shop TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      scopes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  console.log("Database initialized");
}

module.exports = {
  getDatabase,
  initDatabase,
};
