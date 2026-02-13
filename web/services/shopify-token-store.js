// web/services/shopify-token-store.js
// Store and retrieve Shopify offline access tokens

const { getDatabase } = require("../config/database");

function normalizeRow(row, columns) {
  if (!row) return row;
  if (Array.isArray(row) && Array.isArray(columns)) {
    const obj = {};
    for (let i = 0; i < columns.length; i += 1) {
      obj[columns[i]] = row[i];
    }
    return obj;
  }
  return row;
}

function normalizeRows(result) {
  if (!result || !Array.isArray(result.rows)) return [];
  const columns = result.columns;
  return result.rows.map((row) => normalizeRow(row, columns));
}

async function getAccessToken(shop) {
  const db = getDatabase();
  const result = await db.execute({
    sql: "SELECT access_token FROM shopify_tokens WHERE shop = ?",
    args: [shop],
  });

  const rows = normalizeRows(result);
  return rows[0]?.access_token || null;
}

async function upsertAccessToken(shop, accessToken, scopes) {
  const db = getDatabase();
  await db.execute({
    sql: `INSERT INTO shopify_tokens (shop, access_token, scopes, created_at, updated_at)
          VALUES (?, ?, ?, datetime('now'), datetime('now'))
          ON CONFLICT(shop) DO UPDATE SET
            access_token = excluded.access_token,
            scopes = excluded.scopes,
            updated_at = datetime('now')`,
    args: [shop, accessToken, scopes || null],
  });
}

module.exports = {
  getAccessToken,
  upsertAccessToken,
};
