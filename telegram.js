// Telegram alerts + interactive command handler
const axios = require('axios');
const log = require('./logger');
const config = require('./config');
const { isPaused, setPaused } = require('./state');
const chain = require('./chain');

const BASE = `https://api.telegram.org/bot${config.telegramBotToken}`;

// ── Send a message ─────────────────────────────────────────────────────────────
async function send(text, parseMode = 'HTML') {
  if (!config.telegramBotToken || !config.telegramChatId) return;
  try {
    await axios.post(`${BASE}/sendMessage`, {
      chat_id: config.telegramChatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    }, { timeout: 10_000 });
  } catch (err) {
    console.error('[TG] Send failed:', err.message);
  }
}

// ── Alerts ─────────────────────────────────────────────────────────────────────
async function alertTokenFound(symbol, mint, onChainData) {
  const liq  = onChainData?.liquidityUSD  ? `$${onChainData.liquidityUSD.toFixed(0)} (${onChainData.liquiditySOL.toFixed(1)} SOL)` : '?';
  const age  = onChainData?.ageMinutes    ? onChainData.ageMinutes.toFixed(1) : '?';
  const txns = onChainData?.txnCount      ? onChainData.txnCount : '?';
  const uniq = onChainData?.uniqueWallets ? onChainData.uniqueWallets : '?';
  const buys = onChainData?.buys          ?? '?';
  const sells= onChainData?.sells         ?? '?';

  await send(
    `🔍 <b>Token Found — ${symbol}</b>\n` +
    `<code>${mint}</code>\n\n` +
    `💧 Liquidity: ${liq}\n` +
    `⏱ Age: ${age} mins\n` +
    `📊 Txns: ${txns} (${uniq} unique wallets)\n` +
    `📈 Buys/Sells: ${buys}/${sells}\n\n` +
    `⏳ Executing buy...`
  );
}

async function alertBuy(symbol, mint, entryUSD, entryPrice, txHash) {
  await send(
    `✅ <b>BUY — ${symbol}</b>\n` +
    `<code>${mint.slice(0, 20)}...</code>\n\n` +
    `💵 Amount: $${entryUSD}\n` +
    `💲 Entry price: $${entryPrice.toExponential(4)}\n` +
    `🔗 <a href="https://solscan.io/tx/${txHash}">View tx</a>`
  );
}

async function alertSell(symbol, mint, reason, outUSD, multiplier, profitUSD, txHash) {
  const emoji = profitUSD > 0 ? '💚' : '🔴';
  const reasonLabel = {
    tp1: '🎯 TP1 (50% sold at 2×)',
    profit_floor: '🛡 Profit Floor',
    stop_loss: '🛑 Stop Loss',
    moonbag_exit: '🌙 Moonbag Exit',
  }[reason] || reason;

  await send(
    `${emoji} <b>SELL — ${symbol}</b>\n` +
    `<code>${mint.slice(0, 20)}...</code>\n\n` +
    `📌 Reason: ${reasonLabel}\n` +
    `📈 Multiplier: ${multiplier?.toFixed(2)}×\n` +
    `💵 Received: $${outUSD?.toFixed(2)}\n` +
    `${profitUSD >= 0 ? '💰' : '📉'} P&L: $${profitUSD?.toFixed(2)}\n` +
    `🔗 <a href="https://solscan.io/tx/${txHash}">View tx</a>`
  );
}

async function alertError(symbol, action, message) {
  await send(
    `⚠️ <b>Error — ${symbol || 'Bot'}</b>\n` +
    `Action: ${action}\n` +
    `<code>${message}</code>`
  );
}

// ── Format /status response ────────────────────────────────────────────────────
async function formatStatus() {
  const positions = log.getOpenPositions();
  const paused = isPaused();

  let balanceLine = '';
  try {
    const bal = await chain.getWalletBalance();
    balanceLine = `💰 Balance: ${bal.sol.toFixed(4)} SOL ($${bal.usd.toFixed(2)})\n`;
  } catch {
    balanceLine = '';
  }

  if (!positions.length) {
    return `📊 <b>Bot Status</b>\n\n` +
      `State: ${paused ? '⏸ Paused' : '▶️ Running'}\n` +
      balanceLine +
      `Open positions: 0\n\n` +
      `No active positions.`;
  }

  let text = `📊 <b>Bot Status</b>\n\n` +
    `State: ${paused ? '⏸ Paused' : '▶️ Running'}\n` +
    balanceLine +
    `Open positions: ${positions.length}\n\n`;

  for (const pos of positions) {
    text += `• <b>${pos.token_symbol || pos.token_mint.slice(0, 8)}</b>\n` +
      `  Entry: $${pos.entry_price?.toExponential(4)} | ` +
      `Peak: ${pos.peak_multiplier?.toFixed(2)}× | ` +
      `Remaining: ${pos.remaining_pct}%\n`;
  }

  return text;
}

// ── Format /pnl response ───────────────────────────────────────────────────────
function formatPnL(days = null, label = 'All Time') {
  const data = log.getPnL(days);
  if (!data || data.trades === 0) return `📈 <b>${label} P&L</b>\n\nNo completed trades yet.`;

  const winRate = data.trades > 0 ? ((data.winners / data.trades) * 100).toFixed(0) : 0;
  const profit = data.total_profit?.toFixed(2) || '0.00';
  const best = data.best_trade?.toFixed(2) || '0.00';
  const worst = data.worst_trade?.toFixed(2) || '0.00';

  return (
    `📈 <b>${label} P&L</b>\n\n` +
    `Trades: ${data.trades} (W: ${data.winners} / L: ${data.losers})\n` +
    `Win rate: ${winRate}%\n` +
    `Total P&L: $${profit}\n` +
    `Best trade: $${best}\n` +
    `Worst trade: $${worst}`
  );
}

// ── Format /history ────────────────────────────────────────────────────────────
function formatHistory(limit = 10) {
  const trades = log.getRecentTrades(limit);
  if (!trades.length) return '📋 <b>Recent Trades</b>\n\nNo trades yet.';

  let text = `📋 <b>Recent Trades</b>\n\n`;
  for (const t of trades) {
    const sym = t.token_symbol || t.token_mint.slice(0, 8);
    const pnl = t.profit_usd != null ? ` P&L:$${t.profit_usd.toFixed(2)}` : '';
    const mult = t.multiplier ? ` ${t.multiplier.toFixed(2)}×` : '';
    text += `• ${t.timestamp.slice(5, 16)} <b>${sym}</b> ${t.action.toUpperCase()}${mult}${pnl}\n`;
  }
  return text;
}

// ── Register bot commands (shows "/" menu in Telegram) ─────────────────────────
async function registerCommands() {
  if (!config.telegramBotToken) return;
  try {
    await axios.post(`${BASE}/setMyCommands`, {
      commands: [
        { command: 'status',    description: 'Show bot state and open positions' },
        { command: 'positions', description: 'List all open positions' },
        { command: 'pnl',       description: 'All-time P&L summary' },
        { command: 'daily',     description: 'Today\'s P&L' },
        { command: 'weekly',    description: 'Last 7 days P&L' },
        { command: 'monthly',   description: 'Last 30 days P&L' },
        { command: 'history',   description: 'Last 10 trades' },
        { command: 'pause',     description: 'Pause buying new tokens' },
        { command: 'resume',    description: 'Resume buying new tokens' },
      ],
    });
    console.log('[TG] Commands registered.');
  } catch (err) {
    console.error('[TG] Failed to register commands:', err.message);
  }
}

// ── Long-poll command listener ─────────────────────────────────────────────────
let _offset = 0;

async function pollCommands() {
  if (!config.telegramBotToken || !config.telegramChatId) return;

  try {
    const res = await axios.get(`${BASE}/getUpdates`, {
      params: { offset: _offset, timeout: 30, allowed_updates: ['message'] },
      timeout: 35_000,
    });

    const updates = res.data?.result || [];
    for (const update of updates) {
      _offset = update.update_id + 1;

      const msg = update.message;
      if (!msg || !msg.text) continue;

      // Only respond to the configured chat
      if (String(msg.chat.id) !== String(config.telegramChatId)) continue;

      const cmd = msg.text.split(' ')[0].toLowerCase().replace('/', '');

      switch (cmd) {
        case 'status':
          await send(await formatStatus());
          break;

        case 'positions':
          await send(await formatStatus());
          break;

        case 'pnl':
          await send(formatPnL(null, 'All-Time'));
          break;

        case 'daily':
          await send(formatPnL(1, 'Today\'s'));
          break;

        case 'weekly':
          await send(formatPnL(7, 'Last 7 Days'));
          break;

        case 'monthly':
          await send(formatPnL(30, 'Last 30 Days'));
          break;

        case 'history':
          await send(formatHistory(10));
          break;

        case 'pause':
          setPaused(true);
          await send('⏸ Bot paused. No new tokens will be bought.');
          break;

        case 'resume':
          setPaused(false);
          await send('▶️ Bot resumed. Now scanning for new tokens.');
          break;

        default:
          // ignore unknown commands
          break;
      }
    }
  } catch (err) {
    if (err.code !== 'ECONNABORTED') {
      console.error('[TG] Poll error:', err.message);
    }
  }

  // Schedule next poll
  setTimeout(pollCommands, 1000);
}

function startCommandListener() {
  console.log('[TG] Starting command listener...');
  pollCommands();
}

module.exports = {
  send,
  alertTokenFound,
  alertBuy,
  alertSell,
  alertError,
  registerCommands,
  startCommandListener,
};
