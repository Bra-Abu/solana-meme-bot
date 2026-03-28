// Token scanner — monitors Helius for new Solana tokens
const { Helius } = require('helius-sdk');
const { runAllFilters } = require('./filters');
const { executeBuy } = require('./trader');
const log = require('./logger');
const tg = require('./telegram');
const config = require('./config');

let _helius = null;
const processing = new Set(); // prevent duplicate processing
const { isPaused, setPaused } = require('./state');

function getHelius() {
  if (!_helius) _helius = new Helius(config.heliusApiKey);
  return _helius;
}

// ── Process a candidate token ──────────────────────────────────────────────────
async function processToken(tokenMint) {
  if (_paused) return;
  if (processing.has(tokenMint)) return;
  if (log.wasScanned(tokenMint)) return;

  processing.add(tokenMint);

  try {
    console.log(`[SCANNER] Evaluating: ${tokenMint.slice(0, 12)}...`);

    const result = await runAllFilters(tokenMint);

    if (!result.passed) {
      log.markScanned(tokenMint, false, result.reason);
      console.log(`[SCANNER] ❌ ${tokenMint.slice(0, 8)} — ${result.reason}`);
      return;
    }

    // All filters passed — BUY
    const symbol = result.pairData?.baseToken?.symbol || 'UNKNOWN';
    const name = result.pairData?.baseToken?.name || symbol;

    console.log(`[SCANNER] ✅ PASSED ALL FILTERS: ${symbol} (${tokenMint.slice(0, 8)})`);
    log.markScanned(tokenMint, true);

    await tg.alertTokenFound(symbol, tokenMint, result.pairData);
    await executeBuy(tokenMint, symbol);

  } catch (err) {
    console.error(`[SCANNER] Error processing ${tokenMint.slice(0, 8)}: ${err.message}`);
  } finally {
    processing.delete(tokenMint);
  }
}

// ── Start WebSocket listener via Helius ───────────────────────────────────────
function startScanner() {
  const helius = getHelius();

  console.log('[SCANNER] Starting Helius WebSocket listener...');

  // Subscribe to new Raydium + Orca pool creation events
  // These indicate a new token pair was created
  helius.connection.onProgramAccountChange(
    // Raydium AMM program
    { pubkey: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', commitment: 'confirmed' },
    async (accountInfo, context) => {
      // Extract token mint from new pool account data
      try {
        const data = accountInfo.accountInfo.data;
        if (data.length < 400) return;
        // Raydium pool layout: token mint A at offset 400, token mint B at 432
        const mintA = new (require('@solana/web3.js').PublicKey)(data.slice(400, 432)).toString();
        const mintB = new (require('@solana/web3.js').PublicKey)(data.slice(432, 464)).toString();

        // Skip SOL/WSOL mints — we want the new token
        const SOL_MINTS = [
          'So11111111111111111111111111111111111111112',
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        ];

        const newToken = SOL_MINTS.includes(mintA) ? mintB : mintA;
        await processToken(newToken);
      } catch { /* skip malformed */ }
    }
  );

  console.log('[SCANNER] ✅ Listening for new tokens on Raydium...');
}

module.exports = { startScanner, processToken };
