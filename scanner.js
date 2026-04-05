// Token scanner — monitors Solana for NEW Raydium + PumpSwap pool creations via onLogs
const { runAllFilters } = require('./filters');
const { executeBuy } = require('./trader');
const { getConnection } = require('./chain');
const log = require('./logger');
const tg = require('./telegram');
const { isPaused } = require('./state');

const processing = new Set();
const seenPools   = new Set();

const RAYDIUM_ID  = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const PUMPSWAP_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

const SOL_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
]);

const IGNORE_MINTS = new Set([
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
]);

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

// ── Fetch transaction and extract instruction accounts ─────────────────────────
async function getTxAccounts(connection, signature, programId) {
  const tx = await connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed',
  });
  if (!tx) return null;

  const allIxs = [
    ...(tx.transaction.message.instructions || []),
    ...(tx.meta?.innerInstructions?.flatMap(i => i.instructions) || []),
  ];

  const ix = allIxs.find(i =>
    (i.programId?.toString() || i.program) === programId && Array.isArray(i.accounts) && i.accounts.length >= 7
  );

  return ix ? ix.accounts.map(a => a.toString()) : null;
}

// ── Start log listeners ────────────────────────────────────────────────────────
function startScanner() {
  const connection = getConnection();
  const { PublicKey } = require('@solana/web3.js');

  console.log('[SCANNER] Starting log listeners for new Raydium + PumpSwap pools...');

  // ── Raydium AMM v4 — initialize2 ─────────────────────────────────────────────
  // Instruction accounts:
  //   [4]  amm (pool address)
  //   [7]  lp_mint
  //   [8]  coin_mint  (base token)
  //   [9]  pc_mint    (quote, usually SOL)
  //   [10] pool_coin_token_account (base vault)
  //   [11] pool_pc_token_account   (quote vault = SOL vault)
  connection.onLogs(
    new PublicKey(RAYDIUM_ID),
    async ({ signature, logs, err }) => {
      if (err) return;
      if (!logs.some(l => l.includes('initialize2'))) return;

      try {
        const accs = await getTxAccounts(connection, signature, RAYDIUM_ID);
        if (!accs || accs.length < 12) return;

        const poolAddress = accs[4];
        const coinMint    = accs[8];
        const pcMint      = accs[9];
        const lpMint      = accs[7];
        const quoteTokenAccount = SOL_MINTS.has(pcMint) ? accs[11] : accs[10];

        const newToken = SOL_MINTS.has(coinMint) ? pcMint : coinMint;
        if (!newToken || IGNORE_MINTS.has(newToken) || SOL_MINTS.has(newToken)) return;
        if (seenPools.has(newToken)) return;
        seenPools.add(newToken);

        console.log(`[SCANNER] 🆕 New Raydium pool: ${newToken.slice(0, 8)}`);
        await processToken(newToken, poolAddress, { quoteTokenAccount, lpMint, dex: 'raydium' });
      } catch { }
    },
    'confirmed'
  );

  // ── PumpSwap AMM — Create ─────────────────────────────────────────────────────
  // Instruction accounts:
  //   [0]  pool address
  //   [2]  base_mint  (new token)
  //   [3]  quote_mint (SOL)
  //   [4]  lp_mint
  //   [5]  pool_base_token_account
  //   [6]  pool_quote_token_account (SOL vault)
  connection.onLogs(
    new PublicKey(PUMPSWAP_ID),
    async ({ signature, logs, err }) => {
      if (err) return;
      if (!logs.some(l => l.includes('Instruction: Create'))) return;

      try {
        const accs = await getTxAccounts(connection, signature, PUMPSWAP_ID);
        if (!accs || accs.length < 7) return;

        const poolAddress       = accs[0];
        const baseMint          = accs[2];
        const quoteMint         = accs[3];
        const lpMint            = accs[4];
        const quoteTokenAccount = accs[6];

        const newToken = SOL_MINTS.has(baseMint) ? quoteMint : baseMint;
        if (!newToken || IGNORE_MINTS.has(newToken) || SOL_MINTS.has(newToken)) return;
        if (seenPools.has(newToken)) return;
        seenPools.add(newToken);

        console.log(`[SCANNER] 🆕 New PumpSwap pool: ${newToken.slice(0, 8)}`);
        await processToken(newToken, poolAddress, { quoteTokenAccount, lpMint, dex: 'pumpswap' });
      } catch { }
    },
    'confirmed'
  );

  console.log('[SCANNER] ✅ Listening for new Raydium + PumpSwap pool creations...');
}

module.exports = { startScanner, processToken };
