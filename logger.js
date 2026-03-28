const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'meme_bot.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp     TEXT    DEFAULT (datetime('now')),
    token_mint    TEXT    NOT NULL,
    token_symbol  TEXT,
    action        TEXT    NOT NULL,  -- 'buy','tp1','moonbag_exit','stop_loss','profit_floor'
    amount_sol    REAL,
    amount_usd    REAL,
    price_usd     REAL,
    multiplier    REAL,
    profit_usd    REAL,
    tx_hash       TEXT,
    notes         TEXT
  );

  CREATE TABLE IF NOT EXISTS positions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    token_mint      TEXT    UNIQUE NOT NULL,
    token_symbol    TEXT,
    entry_price     REAL    NOT NULL,
    entry_usd       REAL    NOT NULL,
    entry_sol       REAL    NOT NULL,
    remaining_pct   REAL    DEFAULT 100,
    tp1_hit         INTEGER DEFAULT 0,
    peak_profit_usd REAL    DEFAULT 0,
    peak_multiplier REAL    DEFAULT 1,
    status          TEXT    DEFAULT 'open',  -- 'open','closed'
    opened_at       TEXT    DEFAULT (datetime('now')),
    closed_at       TEXT
  );

  CREATE TABLE IF NOT EXISTS scanned_tokens (
    token_mint  TEXT PRIMARY KEY,
    scanned_at  TEXT DEFAULT (datetime('now')),
    passed      INTEGER DEFAULT 0,
    fail_reason TEXT
  );
`);

const log = {
  // Record a trade action
  trade(data) {
    db.prepare(`
      INSERT INTO trades (token_mint, token_symbol, action, amount_sol, amount_usd, price_usd, multiplier, profit_usd, tx_hash, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.tokenMint, data.tokenSymbol, data.action,
      data.amountSol || null, data.amountUsd || null,
      data.priceUsd || null, data.multiplier || null,
      data.profitUsd || null, data.txHash || null,
      data.notes || null
    );
    console.log(`[${new Date().toISOString()}] [${data.tokenSymbol || data.tokenMint?.slice(0,8)}] ${data.action.toUpperCase()}${data.profitUsd ? ` profit:$${data.profitUsd.toFixed(2)}` : ''}${data.multiplier ? ` ${data.multiplier.toFixed(2)}×` : ''}`);
  },

  // Open a new position
  openPosition(data) {
    db.prepare(`
      INSERT OR REPLACE INTO positions (token_mint, token_symbol, entry_price, entry_usd, entry_sol)
      VALUES (?, ?, ?, ?, ?)
    `).run(data.tokenMint, data.tokenSymbol, data.entryPrice, data.entryUsd, data.entrySol);
  },

  // Update position state
  updatePosition(tokenMint, updates) {
    const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(updates), tokenMint];
    db.prepare(`UPDATE positions SET ${fields} WHERE token_mint = ?`).run(...values);
  },

  // Get open position
  getPosition(tokenMint) {
    return db.prepare(`SELECT * FROM positions WHERE token_mint = ? AND status = 'open'`).get(tokenMint);
  },

  // Get all open positions
  getOpenPositions() {
    return db.prepare(`SELECT * FROM positions WHERE status = 'open'`).all();
  },

  // Mark token as scanned
  markScanned(tokenMint, passed, failReason = null) {
    db.prepare(`INSERT OR IGNORE INTO scanned_tokens (token_mint, passed, fail_reason) VALUES (?, ?, ?)`)
      .run(tokenMint, passed ? 1 : 0, failReason);
  },

  // Was this token already scanned?
  wasScanned(tokenMint) {
    return !!db.prepare(`SELECT 1 FROM scanned_tokens WHERE token_mint = ?`).get(tokenMint);
  },

  // P&L queries
  getPnL(days = null) {
    const where = days
      ? `WHERE timestamp > datetime('now', '-${days} days') AND action IN ('tp1','moonbag_exit','stop_loss','profit_floor')`
      : `WHERE action IN ('tp1','moonbag_exit','stop_loss','profit_floor')`;
    return db.prepare(`
      SELECT
        COUNT(DISTINCT token_mint)  AS trades,
        SUM(CASE WHEN profit_usd > 0 THEN 1 ELSE 0 END) AS winners,
        SUM(CASE WHEN profit_usd < 0 THEN 1 ELSE 0 END) AS losers,
        SUM(profit_usd)             AS total_profit,
        MAX(profit_usd)             AS best_trade,
        MIN(profit_usd)             AS worst_trade
      FROM trades
      ${where}
    `).get();
  },

  getRecentTrades(limit = 20) {
    return db.prepare(`SELECT * FROM trades ORDER BY id DESC LIMIT ?`).all(limit);
  },
};

module.exports = log;
