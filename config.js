require('dotenv').config();

module.exports = {
  // ── Network ────────────────────────────────────────────────────────────────
  heliusApiKey: process.env.HELIUS_API_KEY,
  rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,
  walletAddress: process.env.WALLET_ADDRESS,

  // ── Token Filter Criteria ──────────────────────────────────────────────────
  filters: {
    minAgeMinutes: 10,
    maxAgeMinutes: 30,
    minLiquidityUSD: 100_000,
    minBuyVolumeUSD: 100_000,
    minSellVolumeUSD: 50_000,
    minBuyTransactions: 50,
    minSellTransactions: 50,
    minUniqueBuyers: 50,

    // Non-fresh whale wallets
    minWhaleWallets: 10,           // must have >10 qualifying whale wallets
    whaleMinBuyUSD: 1_000,         // each whale bought >$1,000
    walletMinAgeDays: 7,           // wallet older than 7 days
    walletMinTxCount: 20,          // wallet has >20 transactions
    walletMinTxSizeUSD: 500,       // each of those txns >$500

    // Safety
    maxSingleHolderPct: 30,        // no wallet holds >30% of supply
    requireMintRevoked: true,
    requireFreezeDisabled: true,
  },

  // ── Trade Sizing ───────────────────────────────────────────────────────────
  trade: {
    entryUSD: 20,                  // $20 per trade
    maxSlippagePct: 3,             // max 3% slippage on buy
    sellSlippagePct: 5,            // max 5% slippage on sell
    priorityFeeLamports: 100_000,  // priority fee to beat other bots
  },

  // ── Exit Strategy ─────────────────────────────────────────────────────────
  exits: {
    // First take profit
    tp1Multiplier: 2,              // sell 50% at 2×
    tp1SellPct: 50,                // sell 50% of position

    // Moonbag trailing stop
    moonbagActivationMultiplier: 5, // trailing stop activates at 5×
    moonbagTrailingPct: 20,         // sell if drops 20% from peak after 5×

    // Stop loss
    stopLossPct: 30,               // cut 100% if -30% from entry

    // Profit floor (per trade)
    // Floor tightens as profit grows
    profitFloors: [
      { aboveMultiplier: 0, floorPct: 50 },   // up to 2×: protect 50% of peak profit
      { aboveMultiplier: 2, floorPct: 60 },   // 2×→5×: protect 60%
      { aboveMultiplier: 5, floorPct: 70 },   // above 5×: protect 70%
    ],
  },

  // ── Telegram ──────────────────────────────────────────────────────────────
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId:   process.env.TELEGRAM_CHAT_ID,

  // ── Monitor ───────────────────────────────────────────────────────────────
  positionCheckIntervalSec: 30,    // check open positions every 30 seconds
  scanIntervalMs: 5_000,           // scan for new tokens every 5 seconds
};
