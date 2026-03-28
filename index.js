// Solana Meme Bot — entry point
require('dotenv').config();

const { startScanner, processToken } = require('./scanner');
const { restoreOpenPositions } = require('./trader');
const tg = require('./telegram');
const config = require('./config');
const log = require('./logger');

// ── Validate env ───────────────────────────────────────────────────────────────
function checkEnv() {
  const required = ['PRIVATE_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`[BOOT] Missing env vars: ${missing.join(', ')}`);
    console.error('[BOOT] Please fill in your .env file and restart.');
    process.exit(1);
  }
}

// ── Graceful shutdown ──────────────────────────────────────────────────────────
function setupShutdown() {
  const shutdown = async (signal) => {
    console.log(`\n[BOOT] ${signal} received — shutting down gracefully...`);
    await tg.send('🔴 <b>Bot shutting down</b> (' + signal + ')');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', async (err) => {
    console.error('[BOOT] Uncaught exception:', err);
    await tg.alertError('Bot', 'uncaughtException', err.message).catch(() => {});
  });

  process.on('unhandledRejection', async (reason) => {
    console.error('[BOOT] Unhandled rejection:', reason);
  });
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║       SOLANA MEME BOT  v1.0          ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');

  checkEnv();
  setupShutdown();

  // Register Telegram "/" command menu
  await tg.registerCommands();

  // Start Telegram command listener
  tg.startCommandListener();

  // Restore any open positions from previous session
  await restoreOpenPositions();

  // Start WebSocket scanner
  startScanner();

  // Startup notification
  const openPositions = log.getOpenPositions();
  const pnl = log.getPnL();

  await tg.send(
    '🟢 <b>Meme Bot Online</b>\n\n' +
    `Open positions: ${openPositions.length}\n` +
    `All-time P&L: $${(pnl?.total_profit || 0).toFixed(2)}\n\n` +
    `Type / to see all commands.`
  );

  console.log('[BOOT] ✅ Bot is live. Monitoring Solana for new tokens...');
  console.log(`[BOOT] Trade size: $${config.trade.entryUSD} | Slippage: ${config.trade.maxSlippagePct}%`);
  console.log(`[BOOT] Filters: minLiq=$${config.filters.minLiquidityUSD} | minVol=$${config.filters.minBuyVolumeUSD}`);
  console.log('');
}

main().catch(err => {
  console.error('[BOOT] Fatal error:', err);
  process.exit(1);
});
