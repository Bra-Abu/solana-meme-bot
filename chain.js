// Solana chain connection + Jupiter swap execution
require('dotenv').config();
const { Connection, PublicKey, Keypair, VersionedTransaction } = require('@solana/web3.js');
const { createJupiterApiClient } = require('@jup-ag/api');
const bs58 = require('bs58');
const axios = require('axios');
const config = require('./config');

// ── Connection ─────────────────────────────────────────────────────────────────
let _connection = null;
function getConnection() {
  if (!_connection) {
    _connection = new Connection(config.rpcUrl, { commitment: 'confirmed' });
  }
  return _connection;
}

// ── Wallet ─────────────────────────────────────────────────────────────────────
let _keypair = null;
function getKeypair() {
  if (!_keypair) {
    if (!process.env.PRIVATE_KEY) throw new Error('PRIVATE_KEY not set in .env');
    const decoded = bs58.default.decode(process.env.PRIVATE_KEY);
    _keypair = Keypair.fromSecretKey(decoded);
  }
  return _keypair;
}

// ── Jupiter Client ─────────────────────────────────────────────────────────────
let _jupiter = null;
function getJupiter() {
  if (!_jupiter) {
    _jupiter = createJupiterApiClient();
  }
  return _jupiter;
}

// SOL mint address
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// ── Get SOL price in USD ───────────────────────────────────────────────────────
let _solPrice = null;
let _solPriceTs = 0;
async function getSolPriceUSD() {
  if (_solPrice && Date.now() - _solPriceTs < 60_000) return _solPrice;
  try {
    const res = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { timeout: 5000 }
    );
    _solPrice = res.data.solana.usd;
    _solPriceTs = Date.now();
    return _solPrice;
  } catch {
    return _solPrice || 150; // fallback
  }
}

// ── Convert USD to lamports ────────────────────────────────────────────────────
async function usdToLamports(usd) {
  const solPrice = await getSolPriceUSD();
  const sol = usd / solPrice;
  return Math.floor(sol * 1e9);
}

// ── Buy token via Jupiter ──────────────────────────────────────────────────────
async function buyToken(tokenMint, entryUSD) {
  const jupiter = getJupiter();
  const keypair = getKeypair();
  const connection = getConnection();

  const inputAmountLamports = await usdToLamports(entryUSD);
  const slippageBps = config.trade.maxSlippagePct * 100;

  console.log(`[BUY] ${tokenMint.slice(0, 8)}... | $${entryUSD} | ${inputAmountLamports} lamports`);

  // Get best route
  const quote = await jupiter.quoteGet({
    inputMint: SOL_MINT,
    outputMint: tokenMint,
    amount: inputAmountLamports,
    slippageBps,
    onlyDirectRoutes: false,
  });

  if (!quote) throw new Error('No Jupiter quote found');

  // Get swap transaction
  const { swapTransaction } = await jupiter.swapPost({
    swapRequest: {
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toString(),
      prioritizationFeeLamports: config.trade.priorityFeeLamports,
      dynamicComputeUnitLimit: true,
    },
  });

  // Deserialize, sign, send
  const swapTxBuf = Buffer.from(swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(swapTxBuf);
  tx.sign([keypair]);

  const txHash = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  await connection.confirmTransaction(txHash, 'confirmed');

  const solPrice = await getSolPriceUSD();
  const entrySol = inputAmountLamports / 1e9;
  const outputTokens = Number(quote.outAmount);
  const entryPrice = (entryUSD) / outputTokens;

  console.log(`[BUY] ✅ tx: ${txHash} | got ${outputTokens} tokens`);

  return { txHash, entrySol, entryPrice, outputTokens, inputAmountLamports };
}

// ── Sell token via Jupiter ─────────────────────────────────────────────────────
async function sellToken(tokenMint, tokenAmount, symbol = '') {
  const jupiter = getJupiter();
  const keypair = getKeypair();
  const connection = getConnection();

  const slippageBps = config.trade.sellSlippagePct * 100;
  const amountRaw = Math.floor(tokenAmount);

  console.log(`[SELL] ${symbol || tokenMint.slice(0, 8)}... | ${amountRaw} tokens`);

  const quote = await jupiter.quoteGet({
    inputMint: tokenMint,
    outputMint: SOL_MINT,
    amount: amountRaw,
    slippageBps,
    onlyDirectRoutes: false,
  });

  if (!quote) throw new Error('No Jupiter quote for sell');

  const { swapTransaction } = await jupiter.swapPost({
    swapRequest: {
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toString(),
      prioritizationFeeLamports: config.trade.priorityFeeLamports,
      dynamicComputeUnitLimit: true,
    },
  });

  const swapTxBuf = Buffer.from(swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(swapTxBuf);
  tx.sign([keypair]);

  const txHash = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  await connection.confirmTransaction(txHash, 'confirmed');

  const outLamports = Number(quote.outAmount);
  const outSol = outLamports / 1e9;
  const solPrice = await getSolPriceUSD();
  const outUSD = outSol * solPrice;

  console.log(`[SELL] ✅ tx: ${txHash} | received $${outUSD.toFixed(2)}`);
  return { txHash, outSol, outUSD };
}

// ── Get token price from Jupiter ───────────────────────────────────────────────
async function getTokenPriceUSD(tokenMint) {
  try {
    const res = await axios.get(
      `https://price.jup.ag/v6/price?ids=${tokenMint}`,
      { timeout: 5000 }
    );
    return res.data?.data?.[tokenMint]?.price || 0;
  } catch {
    return 0;
  }
}

// ── Get wallet SOL balance ─────────────────────────────────────────────────────
async function getWalletBalance() {
  const connection = getConnection();
  const keypair = getKeypair();
  const lamports = await connection.getBalance(keypair.publicKey);
  const sol = lamports / 1e9;
  const solPrice = await getSolPriceUSD();
  const usd = sol * solPrice;
  return { sol, usd, address: keypair.publicKey.toString() };
}

module.exports = {
  getConnection,
  getKeypair,
  getSolPriceUSD,
  usdToLamports,
  buyToken,
  sellToken,
  getTokenPriceUSD,
  getWalletBalance,
  SOL_MINT,
};
