/**
 * Dump Detection Engine
 *
 * Dua sinyal, masing-masing bisa trigger close secara independent:
 *
 *   1. Price drop sejak deploy  — pool_price sekarang vs pool_price saat deploy
 *                                 Menangkap soft rug (bleed pelan) dan instant rug
 *
 *   2. TVL collapse sejak deploy — TVL sekarang vs TVL saat deploy
 *                                  Menangkap dev remove liquidity
 *
 * Semua data dari Meteora pool API — fresh per check, bukan window agregat.
 *
 * Config keys (user-config.json):
 *   dumpDetectionEnabled   — on/off (default: true)
 *   dumpMinSignals         — jumlah sinyal yang harus aktif untuk trigger close (default: 1)
 *   dumpCheckIntervalSec   — interval check dalam detik (default: 15)
 *   dumpPriceDropPct       — threshold price drop dari deploy (default: -15%)
 *   dumpTvlDropPct         — threshold TVL drop dari deploy (default: -30%)
 */

import { getPoolDetail } from "./screening.js";
import { log } from "../logger.js";

async function fetchUsdPrice(mint) {
  if (!mint) return null;
  try {
    const res = await fetch(`https://lite-api.jup.ag/price/v2?ids=${mint}`);
    if (!res.ok) return null;
    const data = await res.json();
    const price = data?.data?.[mint]?.price;
    return price != null ? parseFloat(price) : null;
  } catch {
    return null;
  }
}

export async function fetchDumpContext(pool_address, { withUsdPrice = false } = {}) {
  if (!pool_address) return { poolDetail: null, usdPrice: null };
  try {
    const poolDetail = await getPoolDetail({ pool_address, timeframe: "5m" });
    const usdPrice = withUsdPrice
      ? await fetchUsdPrice(poolDetail?.token_x?.address ?? null)
      : null;
    return { poolDetail, usdPrice };
  } catch (e) {
    log("dump_warn", `fetchDumpContext failed for ${pool_address}: ${e.message}`);
    return { poolDetail: null, usdPrice: null };
  }
}

export function checkDumpSignals(trackedPos, poolDetail, cfg) {
  const signals = [];
  const metrics = {};
  const pair = trackedPos.pool_name || trackedPos.pool?.slice(0, 8) || "unknown";

  const currentPrice = poolDetail?.pool_price ?? poolDetail?.price ?? null;
  const currentTvl   = poolDetail?.tvl ?? poolDetail?.active_tvl ?? null;
  const priceAtDeploy = trackedPos.price_at_deploy ?? null;
  const tvlAtDeploy   = trackedPos.tvl_at_deploy   ?? null;

  metrics.price_now      = currentPrice;
  metrics.price_at_deploy = priceAtDeploy;
  metrics.tvl_now        = currentTvl;
  metrics.tvl_at_deploy  = tvlAtDeploy;

  // ── 1. Pool price drop sejak deploy ──────────────────────────────────────
  const priceThreshold = cfg.dumpPriceDropPct ?? -15;
  if (currentPrice !== null && priceAtDeploy !== null && priceAtDeploy > 0) {
    const priceDrop = ((currentPrice - priceAtDeploy) / priceAtDeploy) * 100;
    metrics.price_drop_pct = parseFloat(priceDrop.toFixed(2));
    if (priceDrop <= priceThreshold) {
      signals.push(
        `harga turun ${priceDrop.toFixed(1)}% sejak deploy ` +
        `($${priceAtDeploy.toFixed(6)} → $${currentPrice.toFixed(6)}) ` +
        `[threshold: ${priceThreshold}%]`
      );
    }
  }

  // ── 2. TVL collapse sejak deploy ──────────────────────────────────────────
  const tvlThreshold = cfg.dumpTvlDropPct ?? -30;
  if (currentTvl !== null && tvlAtDeploy !== null && tvlAtDeploy > 0) {
    const tvlDrop = ((currentTvl - tvlAtDeploy) / tvlAtDeploy) * 100;
    metrics.tvl_drop_pct = parseFloat(tvlDrop.toFixed(2));
    if (tvlDrop <= tvlThreshold) {
      signals.push(
        `TVL turun ${tvlDrop.toFixed(1)}% sejak deploy ` +
        `($${Math.round(tvlAtDeploy).toLocaleString()} → $${Math.round(currentTvl).toLocaleString()}) ` +
        `[threshold: ${tvlThreshold}%]`
      );
    }
  }

  // ── Result ────────────────────────────────────────────────────────────────
  const minSignals = cfg.dumpMinSignals ?? 1;

  const metricsSummary = [
    metrics.price_drop_pct != null ? `price=${metrics.price_drop_pct}%` : null,
    metrics.tvl_drop_pct   != null ? `tvl=${metrics.tvl_drop_pct}%`     : null,
  ].filter(Boolean).join(" | ");

  if (signals.length < minSignals) {
    log("dump", `[${pair}] OK — ${signals.length}/${minSignals} sinyal (${metricsSummary || "no data"})`);
    return { isDump: false, signals, metrics };
  }

  const reason = `🚨 DUMP [${pair}] — ${signals.join(" | ")}`;
  log("dump_warn", `[${pair}] ${signals.length} sinyal aktif → close`);
  return { isDump: true, reason, signals, metrics };
}
