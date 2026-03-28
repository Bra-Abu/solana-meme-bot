// Token filter pipeline — gates ①-④ run in parallel, ⑤-⑧ sequential
const axios = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');
const config = require('./config');
const { getConnection } = require('./chain');

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex/tokens';
const HELIUS_BASE = `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;

// ── Fetch DexScreener data for a token ────────────────────────────────────────
async function getDexScreenerData(tokenMint) {
  const res = await axios.get(`${DEXSCREENER_BASE}/${tokenMint}`, { timeout: 8000 });
  const pairs = res.data?.pairs;
  if (!pairs || !pairs.length) return null;
  // Pick the pair with highest liquidity
  return pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
}

// ── Gate ①-④: Cheap filters (run in PARALLEL) ────────────────────────────────
async function runCheapFilters(tokenMint, pairData) {
  const now = Date.now();
  const createdAt = pairData.pairCreatedAt;
  const ageMinutes = (now - createdAt) / 60_000;

  const checks = await Promise.all([
    // ① Age check
    Promise.resolve({
      name: 'age',
      pass: ageMinutes >= config.filters.minAgeMinutes && ageMinutes <= config.filters.maxAgeMinutes,
      value: ageMinutes.toFixed(1) + ' mins',
    }),
    // ② Liquidity
    Promise.resolve({
      name: 'liquidity',
      pass: (pairData.liquidity?.usd || 0) >= config.filters.minLiquidityUSD,
      value: '$' + (pairData.liquidity?.usd || 0).toFixed(0),
    }),
    // ③ Volume
    Promise.resolve({
      name: 'volume',
      pass: (pairData.volume?.h24 || 0) >= config.filters.minBuyVolumeUSD,
      value: '$' + (pairData.volume?.h24 || 0).toFixed(0),
    }),
    // ④ Buy/sell txn counts + buy > sell ratio
    Promise.resolve({
      name: 'transactions',
      pass: (pairData.txns?.h24?.buys || 0) >= config.filters.minBuyTransactions &&
            (pairData.txns?.h24?.sells || 0) >= config.filters.minSellTransactions &&
            (pairData.txns?.h24?.buys || 0) > (pairData.txns?.h24?.sells || 0),
      value: `buys:${pairData.txns?.h24?.buys} sells:${pairData.txns?.h24?.sells}`,
    }),
  ]);

  const failed = checks.find(c => !c.pass);
  return { passed: !failed, failedGate: failed?.name, details: checks };
}

// ── Gate ⑤: Unique buyers (Helius) ────────────────────────────────────────────
async function checkUniqueBuyers(tokenMint) {
  try {
    const res = await axios.post(HELIUS_BASE, {
      jsonrpc: '2.0', id: 1,
      method: 'getSignaturesForAddress',
      params: [tokenMint, { limit: 200 }],
    }, { timeout: 10_000 });

    const sigs = res.data?.result || [];
    const buyers = new Set();
    for (const sig of sigs) {
      if (sig.err) continue;
      buyers.add(sig.memo || sig.signature.slice(0, 20));
    }
    return { passed: buyers.size >= config.filters.minUniqueBuyers, count: buyers.size };
  } catch {
    return { passed: false, count: 0 };
  }
}

// ── Gate ⑥: Non-fresh whale wallets ──────────────────────────────────────────
async function checkWhaleWallets(tokenMint, pairData) {
  try {
    // Get top holders via Helius
    const res = await axios.get(
      `https://api.helius.xyz/v0/addresses/${tokenMint}/balances?api-key=${config.heliusApiKey}`,
      { timeout: 10_000 }
    );

    const holders = res.data?.tokens || [];
    const tokenPriceUSD = pairData.priceUsd ? parseFloat(pairData.priceUsd) : 0;

    let qualifyingWhales = 0;

    for (const holder of holders) {
      const holdingUSD = holder.amount * tokenPriceUSD;
      if (holdingUSD < config.filters.whaleMinBuyUSD) continue;

      // Check wallet history
      const walletRes = await axios.post(HELIUS_BASE, {
        jsonrpc: '2.0', id: 1,
        method: 'getSignaturesForAddress',
        params: [holder.address, { limit: 100 }],
      }, { timeout: 8_000 });

      const txns = walletRes.data?.result || [];
      if (!txns.length) continue;

      // Age check — oldest tx timestamp
      const oldestTx = txns[txns.length - 1];
      const walletAgeMs = Date.now() - (oldestTx.blockTime * 1000);
      const walletAgeDays = walletAgeMs / (1000 * 60 * 60 * 24);
      if (walletAgeDays < config.filters.walletMinAgeDays) continue;

      // Tx count check
      if (txns.length < config.filters.walletMinTxCount) continue;

      // We count this as a qualifying whale
      qualifyingWhales++;
      if (qualifyingWhales >= config.filters.minWhaleWallets) break;
    }

    return {
      passed: qualifyingWhales >= config.filters.minWhaleWallets,
      count: qualifyingWhales,
    };
  } catch (err) {
    console.error('[Filter⑥] Whale check failed:', err.message);
    return { passed: false, count: 0 };
  }
}

// ── Gate ⑦: Holder concentration (<30% max) ──────────────────────────────────
async function checkHolderConcentration(tokenMint) {
  try {
    const res = await axios.get(
      `https://api.helius.xyz/v0/addresses/${tokenMint}/balances?api-key=${config.heliusApiKey}`,
      { timeout: 10_000 }
    );

    const holders = res.data?.tokens || [];
    if (!holders.length) return { passed: false };

    const totalSupply = holders.reduce((sum, h) => sum + h.amount, 0);
    const topHolder = Math.max(...holders.map(h => h.amount));
    const topPct = (topHolder / totalSupply) * 100;

    return {
      passed: topPct <= config.filters.maxSingleHolderPct,
      topHolderPct: topPct.toFixed(1),
    };
  } catch {
    return { passed: false };
  }
}

// ── Gate ⑧: Safety — mint + freeze authority ─────────────────────────────────
async function checkSafety(tokenMint) {
  try {
    const connection = getConnection();
    const mintInfo = await connection.getParsedAccountInfo(new PublicKey(tokenMint));
    const parsed = mintInfo?.value?.data?.parsed?.info;

    if (!parsed) return { passed: false, reason: 'Could not parse mint info' };

    const mintRevoked = parsed.mintAuthority === null;
    const freezeDisabled = parsed.freezeAuthority === null;

    if (!mintRevoked) return { passed: false, reason: 'Mint authority not revoked' };
    if (!freezeDisabled) return { passed: false, reason: 'Freeze authority not disabled' };

    return { passed: true };
  } catch (err) {
    return { passed: false, reason: err.message };
  }
}

// ── Main Filter Runner ─────────────────────────────────────────────────────────
async function runAllFilters(tokenMint) {
  // Step 1: Fetch DexScreener data
  let pairData;
  try {
    pairData = await getDexScreenerData(tokenMint);
    if (!pairData) return { passed: false, reason: 'No DexScreener data' };
  } catch (err) {
    return { passed: false, reason: 'DexScreener fetch failed: ' + err.message };
  }

  // Step 2: Gates ①-④ in PARALLEL (cheap + fast)
  const cheap = await runCheapFilters(tokenMint, pairData);
  if (!cheap.passed) {
    return { passed: false, reason: `Failed gate: ${cheap.failedGate}`, pairData };
  }

  // Step 3: Gates ⑤-⑧ in SEQUENCE (expensive, on-chain)
  const uniqueBuyers = await checkUniqueBuyers(tokenMint);
  if (!uniqueBuyers.passed) {
    return { passed: false, reason: `Unique buyers: ${uniqueBuyers.count} < ${config.filters.minUniqueBuyers}`, pairData };
  }

  const whales = await checkWhaleWallets(tokenMint, pairData);
  if (!whales.passed) {
    return { passed: false, reason: `Whale wallets: ${whales.count} < ${config.filters.minWhaleWallets}`, pairData };
  }

  const concentration = await checkHolderConcentration(tokenMint);
  if (!concentration.passed) {
    return { passed: false, reason: `Top holder: ${concentration.topHolderPct}% > 30%`, pairData };
  }

  const safety = await checkSafety(tokenMint);
  if (!safety.passed) {
    return { passed: false, reason: `Safety: ${safety.reason}`, pairData };
  }

  return { passed: true, pairData };
}

module.exports = { runAllFilters, getDexScreenerData };
