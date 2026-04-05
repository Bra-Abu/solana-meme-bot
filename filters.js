// Token filter pipeline — fully on-chain via Helius (no DexScreener)
const axios = require('axios');
const { PublicKey } = require('@solana/web3.js');
const config = require('./config');
const { getConnection, getSolPriceUSD } = require('./chain');

const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;
const HELIUS_API = `https://api.helius.xyz/v0`;

const BURN_ADDRESSES = new Set([
  '11111111111111111111111111111111',
  '1nc1nerator11111111111111111111111111111111',
]);

// Concurrency limiter — max 2 simultaneous filter runs to avoid RPC flooding
let _active = 0;
const _queue = [];
function acquireSlot() {
  return new Promise(resolve => {
    if (_active < 2) { _active++; resolve(); }
    else _queue.push(resolve);
  });
}
function releaseSlot() {
  if (_queue.length) _queue.shift()();
  else _active--;
}

async function heliusRpc(method, params) {
  const res = await axios.post(HELIUS_RPC, {
    jsonrpc: '2.0', id: 1, method, params,
  }, { timeout: 10_000 });
  if (res.data?.error) throw new Error(res.data.error.message);
  return res.data?.result;
}

// ── Token symbol + name from Helius DAS ───────────────────────────────────────
async function getTokenMeta(tokenMint) {
  try {
    const result = await heliusRpc('getAsset', { id: tokenMint });
    return {
      symbol: result?.content?.metadata?.symbol || tokenMint.slice(0, 8),
      name:   result?.content?.metadata?.name   || 'Unknown',
    };
  } catch {
    return { symbol: tokenMint.slice(0, 8), name: 'Unknown' };
  }
}

// ── Gates ①③④: Pool signatures → age + unique wallets + txn count ────────────
async function getPoolActivity(poolAddress) {
  const sigs = await heliusRpc('getSignaturesForAddress', [poolAddress, { limit: 500 }]);
  if (!sigs?.length) return null;

  const oldest = sigs[sigs.length - 1];
  const ageMinutes = (Date.now() / 1000 - oldest.blockTime) / 60;

  const valid = sigs.filter(s => !s.err);
  const uniqueWallets = new Set(valid.map(s => s.feePayer).filter(Boolean));
  const uniquePct = valid.length > 0 ? (uniqueWallets.size / valid.length) * 100 : 0;

  return {
    ageMinutes,
    txnCount: sigs.length,
    uniqueWallets: uniqueWallets.size,
    uniquePct,
    signatures: sigs,
  };
}

// ── Gate ②: SOL liquidity from pool's quote token account ─────────────────────
async function getLiquidity(quoteTokenAccount) {
  const result = await heliusRpc('getTokenAccountBalance', [quoteTokenAccount]);
  return result?.value?.uiAmount || 0;
}

// ── Gate ⑤: Buy/sell direction via Helius enhanced transactions ───────────────
// tokens leaving pool = user bought | tokens entering pool = user sold
async function getBuySellRatio(signatures, poolAddress, tokenMint) {
  try {
    const last30 = signatures.slice(0, 30).map(s => s.signature);
    const res = await axios.post(
      `${HELIUS_API}/transactions?api-key=${config.heliusApiKey}`,
      { transactions: last30 },
      { timeout: 15_000 }
    );

    let buys = 0, sells = 0;
    for (const tx of res.data || []) {
      for (const t of tx.tokenTransfers || []) {
        if (t.mint !== tokenMint) continue;
        if (t.fromUserAccount === poolAddress) buys++;
        if (t.toUserAccount   === poolAddress) sells++;
      }
    }

    const ratio = sells > 0 ? buys / sells : (buys > 0 ? 99 : 0);
    return { buys, sells, ratio };
  } catch {
    return { buys: 0, sells: 0, ratio: 0 };
  }
}

// ── Gate ⑥: Safety — mint + freeze authority must be revoked ─────────────────
async function checkSafety(tokenMint) {
  try {
    const connection = getConnection();
    const info = await connection.getParsedAccountInfo(new PublicKey(tokenMint));
    const parsed = info?.value?.data?.parsed?.info;
    if (!parsed)                        return { passed: false, reason: 'Cannot parse mint info' };
    if (parsed.mintAuthority   !== null) return { passed: false, reason: 'Mint authority active' };
    if (parsed.freezeAuthority !== null) return { passed: false, reason: 'Freeze authority active' };
    return { passed: true };
  } catch (err) {
    return { passed: false, reason: err.message };
  }
}

// ── Gate ⑦: LP rug check — burn address = safe, single wallet > 50% = risky ──
async function checkLPSafety(lpMint) {
  if (!lpMint) return { passed: true, reason: 'No LP mint' };
  try {
    const accounts = await heliusRpc('getTokenLargestAccounts', [lpMint]);
    const list = accounts?.value || [];
    if (!list.length) return { passed: true, reason: 'No LP accounts found' };

    const top = list[0];
    const ownerInfo = await heliusRpc('getAccountInfo', [top.address, { encoding: 'jsonParsed' }]);
    const owner = ownerInfo?.value?.data?.parsed?.info?.owner;

    // LP burned = permanently locked, safest possible scenario
    if (!owner || BURN_ADDRESSES.has(owner)) return { passed: true, reason: 'LP burned' };

    const total = list.reduce((s, a) => s + parseFloat(a.uiAmount || 0), 0);
    const topPct = total > 0 ? (parseFloat(top.uiAmount || 0) / total) * 100 : 0;

    return {
      passed: topPct <= config.filters.maxLPConcentrationPct,
      topPct: topPct.toFixed(1),
    };
  } catch (err) {
    console.error('[Filter⑦] LP check error:', err.message);
    return { passed: true, reason: 'LP check skipped' }; // fail open — don't miss good tokens
  }
}

// ── Main filter runner ─────────────────────────────────────────────────────────
async function runAllFilters(tokenMint, poolAddress, poolMeta = {}) {
  await acquireSlot();
  try {
    // ── Gates ①③④: One RPC call → age, txn count, unique wallets ─────────────
    let activity;
    try {
      activity = await getPoolActivity(poolAddress);
    } catch (err) {
      return { passed: false, reason: 'Pool fetch failed: ' + err.message };
    }
    if (!activity) return { passed: false, reason: 'No pool signatures found' };

    if (activity.ageMinutes < config.filters.minAgeMinutes)
      return { passed: false, reason: `Too new: ${activity.ageMinutes.toFixed(1)} min` };
    if (activity.ageMinutes > config.filters.maxAgeMinutes)
      return { passed: false, reason: `Too old: ${activity.ageMinutes.toFixed(1)} min` };
    if (activity.txnCount < config.filters.minTxns)
      return { passed: false, reason: `Low activity: ${activity.txnCount} txns` };
    if (activity.uniquePct < config.filters.minUniqueWalletPct)
      return { passed: false, reason: `Wash risk: ${activity.uniquePct.toFixed(1)}% unique wallets` };

    // ── Gate ②: Liquidity ─────────────────────────────────────────────────────
    let liquiditySOL = 0;
    if (poolMeta.quoteTokenAccount) {
      try { liquiditySOL = await getLiquidity(poolMeta.quoteTokenAccount); } catch { }
    }
    if (liquiditySOL < config.filters.minLiquiditySOL)
      return { passed: false, reason: `Low liquidity: ${liquiditySOL.toFixed(1)} SOL` };

    // ── Gate ⑤: Buy/sell ratio ────────────────────────────────────────────────
    const buySell = await getBuySellRatio(activity.signatures, poolAddress, tokenMint);
    if (buySell.ratio < config.filters.minBuySellRatio)
      return { passed: false, reason: `Net selling: ${buySell.buys}B/${buySell.sells}S` };

    // ── Gate ⑥: Safety ───────────────────────────────────────────────────────
    const safety = await checkSafety(tokenMint);
    if (!safety.passed) return { passed: false, reason: `Safety: ${safety.reason}` };

    // ── Gate ⑦: LP rug check ──────────────────────────────────────────────────
    const lp = await checkLPSafety(poolMeta.lpMint);
    if (!lp.passed) return { passed: false, reason: `LP rug risk: ${lp.topPct}% concentrated` };

    // ── Enrich with USD values + token metadata for Telegram alert ─────────────
    const solPrice    = await getSolPriceUSD();
    const liquidityUSD = liquiditySOL * solPrice;
    const meta        = await getTokenMeta(tokenMint);

    return {
      passed: true,
      meta,
      onChainData: {
        liquiditySOL,
        liquidityUSD,
        ageMinutes:    activity.ageMinutes,
        txnCount:      activity.txnCount,
        uniqueWallets: activity.uniqueWallets,
        buys:          buySell.buys,
        sells:         buySell.sells,
      },
    };
  } finally {
    releaseSlot();
  }
}

module.exports = { runAllFilters };
