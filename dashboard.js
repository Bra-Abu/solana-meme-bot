// Solana Meme Bot — Dashboard Server
require('dotenv').config();
const express  = require('express');
const Database = require('better-sqlite3');
const path     = require('path');
const { execSync } = require('child_process');
const axios    = require('axios');
const fs       = require('fs');

const app  = express();
const PORT = process.env.DASHBOARD_PORT || 3001;
const KEY  = process.env.DASHBOARD_KEY;  // optional access key

const db = new Database(path.join(__dirname, 'meme_bot.db'), { readonly: true });

// ── Optional auth ──────────────────────────────────────────────────────────────
function auth(req, res, next) {
  if (!KEY) return next();
  const k = req.query.key || req.headers['x-dashboard-key'];
  if (k !== KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function getPnL(days) {
  const where = days
    ? `WHERE timestamp > datetime('now', '-${days} days') AND action IN ('tp1','moonbag_exit','stop_loss','profit_floor')`
    : `WHERE action IN ('tp1','moonbag_exit','stop_loss','profit_floor')`;
  return db.prepare(`
    SELECT
      COUNT(DISTINCT token_mint)                         AS trades,
      SUM(CASE WHEN profit_usd > 0 THEN 1 ELSE 0 END)  AS winners,
      SUM(CASE WHEN profit_usd < 0 THEN 1 ELSE 0 END)  AS losers,
      COALESCE(SUM(profit_usd), 0)                      AS total_profit,
      MAX(profit_usd)                                    AS best_trade,
      MIN(profit_usd)                                    AS worst_trade
    FROM trades ${where}
  `).get();
}

// ── API: /api/status ───────────────────────────────────────────────────────────
app.get('/api/status', auth, async (req, res) => {
  let botStatus = 'unknown', botUptime = null, restarts = 0;
  try {
    const list = JSON.parse(execSync('pm2 jlist', { timeout: 5000 }).toString());
    const bot  = list.find(p => p.name === 'solana-meme-bot');
    if (bot) {
      botStatus = bot.pm2_env.status;
      restarts  = bot.pm2_env.restart_time;
      if (botStatus === 'online') botUptime = Date.now() - bot.pm2_env.pm_uptime;
    }
  } catch { }

  let balance = { sol: 0, usd: 0, address: '' };
  try {
    const { Connection, Keypair } = require('@solana/web3.js');
    const bs58 = require('bs58');
    const rpc  = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
    const conn = new Connection(rpc, 'confirmed');
    const kp   = Keypair.fromSecretKey(bs58.default.decode(process.env.PRIVATE_KEY));
    const lam  = await conn.getBalance(kp.publicKey);
    const sol  = lam / 1e9;
    const priceRes = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { timeout: 5000 }
    );
    balance = { sol, usd: sol * priceRes.data.solana.usd, address: kp.publicKey.toString() };
  } catch { }

  res.json({ botStatus, botUptime, restarts, balance });
});

// ── API: /api/pnl ──────────────────────────────────────────────────────────────
app.get('/api/pnl', auth, (req, res) => {
  res.json({
    today:   getPnL(1),
    week:    getPnL(7),
    month:   getPnL(30),
    alltime: getPnL(null),
  });
});

// ── API: /api/positions ────────────────────────────────────────────────────────
app.get('/api/positions', auth, async (req, res) => {
  const positions = db.prepare(
    `SELECT * FROM positions WHERE status = 'open' ORDER BY opened_at DESC`
  ).all();

  const enriched = await Promise.all(positions.map(async pos => {
    try {
      const r = await axios.get(`https://price.jup.ag/v6/price?ids=${pos.token_mint}`, { timeout: 5000 });
      const currentPrice = r.data?.data?.[pos.token_mint]?.price || 0;
      const multiplier   = currentPrice > 0 ? currentPrice / pos.entry_price : pos.peak_multiplier;
      const remaining    = pos.entry_usd * (pos.remaining_pct / 100);
      const currentUSD   = remaining * multiplier;
      const profitUSD    = currentUSD - remaining;
      return { ...pos, currentPrice, multiplier, currentUSD, profitUSD };
    } catch {
      return { ...pos, currentPrice: 0, multiplier: pos.peak_multiplier, currentUSD: 0, profitUSD: 0 };
    }
  }));

  res.json(enriched);
});

// ── API: /api/trades ───────────────────────────────────────────────────────────
app.get('/api/trades', auth, (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
  const trades = db.prepare(`SELECT * FROM trades ORDER BY id DESC LIMIT ?`).all(limit);
  res.json(trades);
});

// ── API: /api/scanner ──────────────────────────────────────────────────────────
app.get('/api/scanner', auth, (req, res) => {
  const total   = db.prepare(`SELECT COUNT(*) AS c FROM scanned_tokens`).get().c;
  const passed  = db.prepare(`SELECT COUNT(*) AS c FROM scanned_tokens WHERE passed = 1`).get().c;
  const today   = db.prepare(`SELECT COUNT(*) AS c FROM scanned_tokens WHERE scanned_at > datetime('now','-1 day')`).get().c;
  const reasons = db.prepare(`
    SELECT fail_reason AS reason, COUNT(*) AS count
    FROM scanned_tokens
    WHERE passed = 0 AND fail_reason IS NOT NULL
    GROUP BY fail_reason ORDER BY count DESC LIMIT 8
  `).all();
  res.json({ total, passed, today, passRate: total > 0 ? (passed / total * 100).toFixed(2) : 0, reasons });
});

// ── API: /api/chart/pnl ────────────────────────────────────────────────────────
app.get('/api/chart/pnl', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT date(timestamp) AS day, COALESCE(SUM(profit_usd), 0) AS pnl
    FROM trades
    WHERE action IN ('tp1','moonbag_exit','stop_loss','profit_floor')
      AND timestamp > datetime('now', '-30 days')
    GROUP BY day ORDER BY day ASC
  `).all();
  res.json(rows);
});

// ── Serve dashboard HTML ───────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.listen(PORT, () => {
  console.log(`[DASHBOARD] Live at http://localhost:${PORT}`);
});
