// Trade execution + exit management
const config = require('./config');
const chain = require('./chain');
const log = require('./logger');
const tg = require('./telegram');

// Active position monitors: tokenMint → intervalId
const monitors = new Map();

// ── Calculate profit floor based on current multiplier ────────────────────────
function getProfitFloorPct(currentMultiplier) {
  const floors = [...config.exits.profitFloors].reverse();
  for (const floor of floors) {
    if (currentMultiplier >= floor.aboveMultiplier) return floor.floorPct / 100;
  }
  return 0.5;
}

// ── Execute Buy ────────────────────────────────────────────────────────────────
async function executeBuy(tokenMint, tokenSymbol) {
  try {
    console.log(`[TRADER] Buying ${tokenSymbol || tokenMint.slice(0, 8)}...`);

    const result = await chain.buyToken(tokenMint, config.trade.entryUSD);

    // Record in DB
    log.openPosition({
      tokenMint,
      tokenSymbol,
      entryPrice: result.entryPrice,
      entryUsd: config.trade.entryUSD,
      entrySol: result.entrySol,
    });

    log.trade({
      tokenMint, tokenSymbol,
      action: 'buy',
      amountSol: result.entrySol,
      amountUsd: config.trade.entryUSD,
      priceUsd: result.entryPrice,
      txHash: result.txHash,
    });

    await tg.alertBuy(tokenSymbol, tokenMint, config.trade.entryUSD, result.entryPrice, result.txHash);

    // Start position monitor
    startPositionMonitor(tokenMint, tokenSymbol, result.outputTokens);

    return result;
  } catch (err) {
    console.error(`[TRADER] Buy failed: ${err.message}`);
    await tg.alertError(tokenSymbol, 'buy', err.message);
    throw err;
  }
}

// ── Position Monitor ───────────────────────────────────────────────────────────
function startPositionMonitor(tokenMint, tokenSymbol, totalTokens) {
  if (monitors.has(tokenMint)) return;

  let peakProfitUSD = 0;
  let peakMultiplier = 1;

  const interval = setInterval(async () => {
    try {
      const position = log.getPosition(tokenMint);
      if (!position || position.status !== 'open') {
        clearInterval(interval);
        monitors.delete(tokenMint);
        return;
      }

      const currentPrice = await chain.getTokenPriceUSD(tokenMint);
      if (!currentPrice) return;

      const currentMultiplier = currentPrice / position.entry_price;
      const remainingTokens = totalTokens * (position.remaining_pct / 100);
      const currentValueUSD = remainingTokens * currentPrice;
      const currentProfitUSD = currentValueUSD - (config.trade.entryUSD * position.remaining_pct / 100);

      // Track peak
      if (currentProfitUSD > peakProfitUSD) {
        peakProfitUSD = currentProfitUSD;
        peakMultiplier = currentMultiplier;
        log.updatePosition(tokenMint, { peak_multiplier: peakMultiplier, peak_profit_usd: peakProfitUSD });
      }

      // ── Stop Loss: -30% from entry ─────────────────────────────────────────
      if (currentMultiplier <= (1 - config.exits.stopLossPct / 100)) {
        console.log(`[TRADER] Stop loss hit on ${tokenSymbol}`);
        await executeSell(tokenMint, tokenSymbol, remainingTokens, 'stop_loss', currentPrice, currentMultiplier);
        return;
      }

      // ── TP1: Sell 50% at 2× ────────────────────────────────────────────────
      if (!position.tp1_hit && currentMultiplier >= config.exits.tp1Multiplier) {
        const sellTokens = remainingTokens * (config.exits.tp1SellPct / 100);
        await executeSell(tokenMint, tokenSymbol, sellTokens, 'tp1', currentPrice, currentMultiplier);
        log.updatePosition(tokenMint, { tp1_hit: 1, remaining_pct: position.remaining_pct - config.exits.tp1SellPct });
        return;
      }

      // ── Profit Floor ───────────────────────────────────────────────────────
      if (position.tp1_hit && peakProfitUSD > 0) {
        const floorPct = getProfitFloorPct(peakMultiplier);
        const floorUSD = peakProfitUSD * floorPct;

        if (currentProfitUSD <= floorUSD && currentProfitUSD < peakProfitUSD) {
          console.log(`[TRADER] Profit floor hit on ${tokenSymbol} — peak:$${peakProfitUSD.toFixed(2)} floor:$${floorUSD.toFixed(2)} current:$${currentProfitUSD.toFixed(2)}`);
          await executeSell(tokenMint, tokenSymbol, remainingTokens, 'profit_floor', currentPrice, currentMultiplier);
          return;
        }
      }

      // ── Moonbag trailing stop: activated at 5×, sell if -20% from peak ────
      if (position.tp1_hit && peakMultiplier >= config.exits.moonbagActivationMultiplier) {
        const dropFromPeak = (peakMultiplier - currentMultiplier) / peakMultiplier * 100;
        if (dropFromPeak >= config.exits.moonbagTrailingPct) {
          console.log(`[TRADER] Moonbag trailing stop hit on ${tokenSymbol}`);
          await executeSell(tokenMint, tokenSymbol, remainingTokens, 'moonbag_exit', currentPrice, currentMultiplier);
          return;
        }
      }

    } catch (err) {
      console.error(`[MONITOR] ${tokenSymbol} error: ${err.message}`);
    }
  }, config.positionCheckIntervalSec * 1000);

  monitors.set(tokenMint, interval);
  console.log(`[MONITOR] Started for ${tokenSymbol}`);
}

// ── Execute Sell ───────────────────────────────────────────────────────────────
async function executeSell(tokenMint, tokenSymbol, tokenAmount, reason, currentPrice, multiplier) {
  try {
    const result = await chain.sellToken(tokenMint, tokenAmount, tokenSymbol);
    const profitUSD = result.outUSD - config.trade.entryUSD * (tokenAmount / 100);

    log.trade({
      tokenMint, tokenSymbol,
      action: reason,
      amountUsd: result.outUSD,
      amountSol: result.outSol,
      priceUsd: currentPrice,
      multiplier,
      profitUsd: profitUSD,
      txHash: result.txHash,
    });

    // Close position if fully sold
    const position = log.getPosition(tokenMint);
    if (!position) return;

    const newRemainingPct = reason === 'tp1'
      ? position.remaining_pct - config.exits.tp1SellPct
      : 0;

    if (newRemainingPct <= 0) {
      log.updatePosition(tokenMint, { status: 'closed', remaining_pct: 0, closed_at: new Date().toISOString() });
      clearInterval(monitors.get(tokenMint));
      monitors.delete(tokenMint);
    } else {
      log.updatePosition(tokenMint, { remaining_pct: newRemainingPct });
    }

    await tg.alertSell(tokenSymbol, tokenMint, reason, result.outUSD, multiplier, profitUSD, result.txHash);

  } catch (err) {
    console.error(`[SELL] Failed ${tokenSymbol}: ${err.message}`);
    await tg.alertError(tokenSymbol, reason, err.message);
  }
}

// ── Restore monitors on restart ────────────────────────────────────────────────
async function restoreOpenPositions(totalTokensMap = {}) {
  const positions = log.getOpenPositions();
  for (const pos of positions) {
    const tokens = totalTokensMap[pos.token_mint] || 0;
    startPositionMonitor(pos.token_mint, pos.token_symbol, tokens);
    console.log(`[TRADER] Restored monitor for ${pos.token_symbol}`);
  }
}

module.exports = { executeBuy, startPositionMonitor, restoreOpenPositions };
