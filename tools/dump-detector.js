/**
 * Dump Detection Engine
 *
 * Mendeteksi dump mendadak pada posisi terbuka dengan mengecek:
 *   1. Price crash     — price_change_pct 5m window (default: -15%)
 *   2. LP removal      — TVL turun vs baseline saat deploy (default: -30%)
 *   3. Sell pressure   — sell_vol 1h harus memenuhi DUA kondisi:
 *                          a) sell_vol / buy_vol >= dumpSellBuyRatio (default: 3×)
 *                          b) sell_vol / tvl >= dumpSellPctOfTvl (default: 15%)
 *   4. MC drop         — market cap turun vs baseline saat deploy (default: -25%)
 *   5. Volume spike    — volume 5m / TVL >= dumpVolSpike5mPct (default: 20%)
 *                        DAN harga turun (price_change_pct < 0)
 *                        Menangkap dev dump / whale dump 1 tx yang tidak terdeteksi
 *                        sinyal 3 karena sinyal 3 pakai window 1 jam.
 *
 * Semua threshold bisa diatur via user-config.json (lihat config.js management block).
 */

import { getPoolDetail } from "./screening.js";
import { getTokenInfo } from "./token.js";
import { log } from "../logger.js";

// ─── Data Fetching ───────────────────────────────────────────────────────────

/**
 * Fetch pool detail (5m snapshot) and token info for a position.
 * Both calls run in parallel; either may be null if the API fails.
 *
 * @param {string} pool_address
 * @param {string|null} base_mint  — token mint for sell pressure + MC data
 * @returns {{ poolDetail: object|null, tokenInfo: object|null }}
 */
export async function fetchDumpContext(pool_address, base_mint) {
  if (!pool_address) return { poolDetail: null, tokenInfo: null };

  const [poolRes, tokenRes] = await Promise.allSettled([
    getPoolDetail({ pool_address, timeframe: "5m" }),
    base_mint ? getTokenInfo({ query: base_mint }) : Promise.resolve(null),
  ]);

  const poolDetail = poolRes.status === "fulfilled" ? poolRes.value : null;
  const tokenInfo  =
    tokenRes.status === "fulfilled" && tokenRes.value?.found
      ? (tokenRes.value.results?.[0] ?? null)
      : null;

  if (poolRes.status === "rejected") {
    log("dump_warn", `fetchDumpContext pool fetch failed for ${pool_address}: ${poolRes.reason?.message}`);
  }

  return { poolDetail, tokenInfo };
}

// ─── Signal Detection ────────────────────────────────────────────────────────

/**
 * Check a tracked position for dump signals.
 *
 * @param {object}      trackedPos  — from state (needs .pool, .pool_name, optionally .tvl_at_deploy, .mcap_at_deploy)
 * @param {object|null} poolDetail  — from getPoolDetail("5m"); may be null
 * @param {object|null} tokenInfo   — from getTokenInfo (first result); may be null
 * @param {object}      cfg         — config.management
 * @returns {{ isDump: boolean, reason: string, signals: string[], metrics: object }}
 */
export function checkDumpSignals(trackedPos, poolDetail, tokenInfo, cfg) {
  const signals = [];
  const metrics = {};

  // ── 1. Harga crash (5m window) ──────────────────────────────────────────
  const priceDrop5m    = poolDetail?.price_change_pct ?? null;
  const priceThreshold = cfg.dumpPriceDrop5mPct ?? -15;
  metrics.price_change_5m = priceDrop5m;
  if (priceDrop5m !== null && priceDrop5m <= priceThreshold) {
    signals.push(
      `harga turun ${priceDrop5m.toFixed(1)}% dalam 5m (threshold: ${priceThreshold}%)`
    );
  }

  // ── 2. LP keluar besar (TVL vs baseline saat deploy) ───────────────────
  const currentTvl   = poolDetail?.tvl ?? poolDetail?.active_tvl ?? null;
  const tvlAtDeploy  = trackedPos.tvl_at_deploy ?? null;
  const lpThreshold  = cfg.dumpLpRemovalPct ?? -30;
  metrics.tvl_current    = currentTvl;
  metrics.tvl_at_deploy  = tvlAtDeploy;
  if (currentTvl !== null && tvlAtDeploy !== null && tvlAtDeploy > 0) {
    const tvlDropPct = ((currentTvl - tvlAtDeploy) / tvlAtDeploy) * 100;
    metrics.tvl_drop_pct = parseFloat(tvlDropPct.toFixed(1));
    if (tvlDropPct <= lpThreshold) {
      signals.push(
        `LP keluar: TVL turun ${tvlDropPct.toFixed(0)}% ` +
        `($${Math.round(tvlAtDeploy).toLocaleString()} → $${Math.round(currentTvl).toLocaleString()}) ` +
        `(threshold: ${lpThreshold}%)`
      );
    }
  }

  // ── 3. Tekanan jual — dua kondisi harus terpenuhi sekaligus ────────────
  //
  //   (a) sell_vol / buy_vol >= dumpSellBuyRatio   → tekanan jual relatif ke buyer
  //   (b) sell_vol / current_tvl >= dumpSellPctOfTvl → normalisasi ke ukuran pool
  //
  //   Kondisi (b) mencegah false positive: 1 whale sell $50k di pool $1M TVL
  //   menghasilkan sell/TVL = 5% (tidak signifikan), meski ratio-nya tinggi.
  //   Di pool kecil ($80k TVL), $50k sell = 62% → memang berbahaya.
  const ratioThreshold  = cfg.dumpSellBuyRatio    ?? 3;
  const tvlPctThreshold = cfg.dumpSellPctOfTvl    ?? 15;
  const sellVol = parseFloat(tokenInfo?.stats_1h?.sell_vol ?? 0);
  const buyVol  = parseFloat(tokenInfo?.stats_1h?.buy_vol  ?? 0);
  metrics.sell_vol_1h = sellVol;
  metrics.buy_vol_1h  = buyVol;

  if (currentTvl !== null && currentTvl > 0 && sellVol > 0) {
    const sellPctOfTvl = (sellVol / currentTvl) * 100;
    metrics.sell_pct_of_tvl = parseFloat(sellPctOfTvl.toFixed(1));

    const ratioOk  = buyVol > 0
      ? sellVol / buyVol >= ratioThreshold
      : sellVol > 50; // tidak ada pembeli sama sekali → langsung lolos syarat ratio
    const tvlPctOk = sellPctOfTvl >= tvlPctThreshold;

    if (ratioOk && tvlPctOk) {
      const ratioStr = buyVol > 0 ? `${(sellVol / buyVol).toFixed(1)}×` : "∞";
      metrics.sell_buy_ratio = buyVol > 0 ? parseFloat((sellVol / buyVol).toFixed(1)) : null;
      signals.push(
        `tekanan jual: sell/buy = ${ratioStr}, sell = ${sellPctOfTvl.toFixed(0)}% TVL ` +
        `($${Math.round(sellVol).toLocaleString()} / TVL $${Math.round(currentTvl).toLocaleString()}) ` +
        `(threshold: >${ratioThreshold}× & >${tvlPctThreshold}% TVL)`
      );
    }
  }

  // ── 4. MC turun (vs baseline saat deploy) ──────────────────────────────
  const currentMcap  = tokenInfo?.mcap ?? null;
  const mcapAtDeploy = trackedPos.mcap_at_deploy ?? null;
  const mcapThreshold = cfg.dumpMcapDropPct ?? -25;
  metrics.mcap_current   = currentMcap;
  metrics.mcap_at_deploy = mcapAtDeploy;
  if (currentMcap !== null && mcapAtDeploy !== null && mcapAtDeploy > 0) {
    const mcapDropPct = ((currentMcap - mcapAtDeploy) / mcapAtDeploy) * 100;
    metrics.mcap_drop_pct = parseFloat(mcapDropPct.toFixed(1));
    if (mcapDropPct <= mcapThreshold) {
      signals.push(
        `MC turun ${mcapDropPct.toFixed(0)}% ` +
        `($${Math.round(mcapAtDeploy / 1000)}k → $${Math.round(currentMcap / 1000)}k) ` +
        `(threshold: ${mcapThreshold}%)`
      );
    }
  }

  // ── 5. Volume spike 5m (dev dump / whale dump 1 tx) ───────────────────
  //
  //   Sinyal 3 pakai window 1 jam — kalau dev dump di menit ke-45, ada buy
  //   history dari awal jam yang mengencerkan rasionya → bisa lolos sinyal 3.
  //   Sinyal ini pakai volume 5m dari poolDetail (sudah ada, tidak butuh API baru):
  //     volume_5m / tvl >= dumpVolSpike5mPct  →  ada aktivitas besar mendadak
  //     DAN price_change_pct < 0              →  arahnya turun (bukan pump)
  const volSpike5mThreshold = cfg.dumpVolSpike5mPct ?? 20;
  const volSpikePriceMin    = cfg.dumpVolSpikePriceMinPct ?? -5;
  const vol5m = poolDetail?.volume_window ?? null;
  metrics.vol_5m = vol5m;
  if (
    vol5m !== null && vol5m > 0 &&
    currentTvl !== null && currentTvl > 0 &&
    priceDrop5m !== null && priceDrop5m <= volSpikePriceMin
  ) {
    const volSpikePct = (vol5m / currentTvl) * 100;
    metrics.vol_spike_pct = parseFloat(volSpikePct.toFixed(1));
    if (volSpikePct >= volSpike5mThreshold) {
      signals.push(
        `volume spike: vol 5m = ${volSpikePct.toFixed(0)}% TVL saat harga turun ${priceDrop5m.toFixed(1)}% ` +
        `($${Math.round(vol5m).toLocaleString()} / TVL $${Math.round(currentTvl).toLocaleString()}) ` +
        `(threshold: >${volSpike5mThreshold}% TVL & harga <=${volSpikePriceMin}%)`
      );
    }
  }

  // ── Result ─────────────────────────────────────────────────────────────
  const minSignals = cfg.dumpMinSignals ?? 1;
  if (signals.length < minSignals) {
    return { isDump: false, reason: `only ${signals.length}/${minSignals} dump signals`, signals, metrics };
  }

  const pair = trackedPos.pool_name || trackedPos.pool?.slice(0, 8) || "unknown";
  const reason =
    `🚨 DUMP TERDETEKSI [${pair}] — ${signals.length} sinyal: ` +
    signals.join(" | ");

  return { isDump: true, reason, signals, metrics };
}
