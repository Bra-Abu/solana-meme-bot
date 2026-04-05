// Token scanner — monitors Solana for new Raydium + PumpSwap pools
const { runAllFilters } = require('./filters');
const { executeBuy } = require('./trader');
const { getConnection } = require('./chain');
const log = require('./logger');
const tg = require('./telegram');
const config = require('./config');
const { isPaused } = require('./state');

const processing = new Set(); // prevent duplicate processing
const seenPools   = new Set(); // each pool evaluated once only

const STARTUP_GRACE_MS = 3 * 60 * 1000;
const startedAt = Date.now();

// ── Process a candidate token ──────────────────────────────────────────────────
async function processToken(tokenMint, poolAddress, poolMeta = {}) {
  if (isPaused()) return;
  if (processing.has(tokenMint)) return;
  if (log.wasScanned(tokenMint)) return;

  processing.add(tokenMint);

  try {
    console.log(`[SCANNER] Evaluating: ${tokenMint.slice(0, 12)}...`);

    const result = await runAllFilters(tokenMint, poolAddress, poolMeta);

    if (!result.passed) {
      log.markScanned(tokenMint, false, result.reason);
      console.log(`[SCANNER] ❌ ${tokenMint.slice(0, 8)} — ${result.reason}`);
      return;
    }

    const { meta, onChainData } = result;
    console.log(`[SCANNER] ✅ PASSED ALL FILTERS: ${meta.symbol} (${tokenMint.slice(0, 8)})`);
    log.markScanned(tokenMint, true);

    await tg.alertTokenFound(meta.symbol, tokenMint, onChainData);
    await executeBuy(tokenMint, meta.symbol);

  } catch (err) {
    console.error(`[SCANNER] Error processing ${tokenMint.slice(0, 8)}: ${err.message}`);
  } finally {
    processing.delete(tokenMint);
  }
}

// ── Start WebSocket listeners ──────────────────────────────────────────────────
function startScanner() {
  const connection = getConnection();
  const { PublicKey } = require('@solana/web3.js');

  const SOL_MINTS = new Set([
    'So11111111111111111111111111111111111111112',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  ]);

  const IGNORE_MINTS = new Set([
    '11111111111111111111111111111111',
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  ]);

  // Helper: silently skip old pools during startup replay
  function shouldSkipDuringGrace(poolAddress) {
    return (Date.now() - startedAt) < STARTUP_GRACE_MS;
  }

  console.log('[SCANNER] Starting WebSocket listeners for Raydium + PumpSwap...');

  // ── Raydium AMM v4 pool layout ───────────────────────────────────────────────
  // [336..368] pool_coin_token_account (base vault)
  // [368..400] pool_pc_token_account  (quote vault = WSOL vault)
  // [400..432] coin_mint_address
  // [432..464] pc_mint_address
  // [464..496] lp_mint_address
  connection.onProgramAccountChange(
    new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'),
    async (keyedAccountInfo) => {
      try {
        const poolAddress = keyedAccountInfo.accountId.toString();
        if (seenPools.has(poolAddress)) return;
        seenPools.add(poolAddress);
        if (shouldSkipDuringGrace()) return;

        const data = keyedAccountInfo.accountInfo.data;
        if (data.length < 496) return;

        const mintA = new PublicKey(data.slice(400, 432)).toString();
        const mintB = new PublicKey(data.slice(432, 464)).toString();
        if (IGNORE_MINTS.has(mintA) || IGNORE_MINTS.has(mintB)) return;

        const newToken = SOL_MINTS.has(mintA) ? mintB : mintA;
        if (IGNORE_MINTS.has(newToken)) return;

        // Quote vault is the WSOL account (pc = SOL side)
        const quoteTokenAccount = SOL_MINTS.has(mintB)
          ? new PublicKey(data.slice(368, 400)).toString()  // pc vault
          : new PublicKey(data.slice(336, 368)).toString(); // coin vault

        const lpMint = new PublicKey(data.slice(464, 496)).toString();

        await processToken(newToken, poolAddress, { quoteTokenAccount, lpMint, dex: 'raydium' });
      } catch { /* skip malformed */ }
    }
  );

  // ── PumpSwap AMM pool layout ─────────────────────────────────────────────────
  // [8]        pool_bump
  // [9..11]    index
  // [11..43]   creator
  // [43..75]   base_mint  ← new token
  // [75..107]  quote_mint ← WSOL
  // [107..139] lp_mint
  // [139..171] base_token_account
  // [171..203] quote_token_account ← WSOL vault
  connection.onProgramAccountChange(
    new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'),
    async (keyedAccountInfo) => {
      try {
        const poolAddress = keyedAccountInfo.accountId.toString();
        if (seenPools.has(poolAddress)) return;
        seenPools.add(poolAddress);
        if (shouldSkipDuringGrace()) return;

        const data = keyedAccountInfo.accountInfo.data;
        if (data.length < 300) return;

        const baseMint  = new PublicKey(data.slice(43,  75)).toString();
        const quoteMint = new PublicKey(data.slice(75, 107)).toString();
        if (IGNORE_MINTS.has(baseMint) || IGNORE_MINTS.has(quoteMint)) return;

        const newToken = SOL_MINTS.has(baseMint) ? quoteMint : baseMint;
        if (IGNORE_MINTS.has(newToken)) return;

        const lpMint             = new PublicKey(data.slice(107, 139)).toString();
        const quoteTokenAccount  = new PublicKey(data.slice(171, 203)).toString();

        await processToken(newToken, poolAddress, { quoteTokenAccount, lpMint, dex: 'pumpswap' });
      } catch { /* skip malformed */ }
    }
  );

  console.log('[SCANNER] ✅ Listening on Raydium AMM + PumpSwap AMM...');
}

module.exports = { startScanner, processToken };
