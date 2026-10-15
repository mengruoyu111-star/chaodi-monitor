/**
 * 波动率计算
 *
 * 背景：原文的「中证1000VIX」通常取自期权论坛的 QVIX 指数，
 * 但该数据源的 1000 股指序列自 2026 年起公式损坏、已停止更新。
 * 因此这里用中金所 MO（中证1000股指期权）的实时链自行复算，
 * 采用 CBOE VIX 的方差互换口径，取剩余期限最接近 30 天的合约。
 */

/** 误差函数（Abramowitz & Stegun 7.1.26 近似，精度 ~1e-7） */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return sign * y;
}

/** 标准正态分布函数 */
export const normCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));

/** 某年某月的第三个周五（中金所股指期权到期日） */
export function thirdFriday(year, month) {
  const d = new Date(year, month - 1, 1);
  let count = 0;
  while (true) {
    if (d.getDay() === 5) {
      count += 1;
      if (count === 3) return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 15, 0, 0);
    }
    d.setDate(d.getDate() + 1);
  }
}

/** 由「YYMM」推出到期日 */
export function expiryOf(yymm) {
  const yy = 2000 + Number(yymm.slice(0, 2));
  const mm = Number(yymm.slice(2, 4));
  return thirdFriday(yy, mm);
}

/** 剩余年化期限 */
export function yearsToExpiry(expiry, now = new Date()) {
  const days = (expiry.getTime() - now.getTime()) / 86400000;
  return { days, T: Math.max(days, 0.5) / 365 };
}

/**
 * 用 CBOE VIX 口径计算隐波（返回百分数，例如 28.6）
 * @param {{calls:Array,puts:Array}} chain 期权链，元素形如 {strike,last,oi}
 * @param {number} F   合成远期价
 * @param {number} T   剩余年化期限
 * @param {number} r   无风险利率
 */
export function vixStyleVol(chain, F, T, r = 0.018) {
  const map = new Map();
  for (const o of chain.calls ?? []) {
    if (!Number.isFinite(o.strike) || !Number.isFinite(o.last)) continue;
    const e = map.get(o.strike) ?? { K: o.strike, c: null, p: null };
    e.c = o.last;
    map.set(o.strike, e);
  }
  for (const o of chain.puts ?? []) {
    if (!Number.isFinite(o.strike) || !Number.isFinite(o.last)) continue;
    const e = map.get(o.strike) ?? { K: o.strike, c: null, p: null };
    e.p = o.last;
    map.set(o.strike, e);
  }
  const rows = [...map.values()].sort((a, b) => a.K - b.K);
  if (rows.length < 8) return null;

  // K0：低于 F 的最大行权价
  const below = rows.filter((x) => x.K <= F);
  const K0 = (below.length ? below[below.length - 1] : rows[0]).K;
  const forward = Number.isFinite(F) && F > 0 ? F : K0;

  let sum = 0;
  let used = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const price = row.K < K0 ? row.p : row.K > K0 ? row.c : (row.c ?? 0) + (row.p ?? 0) > 0
      ? ((row.c ?? 0) + (row.p ?? 0)) / 2
      : null;
    if (!Number.isFinite(price) || price <= 0) continue;
    const prevK = rows[i - 1]?.K ?? row.K;
    const nextK = rows[i + 1]?.K ?? row.K;
    const dK = i === 0 ? nextK - row.K : i === rows.length - 1 ? row.K - prevK : (nextK - prevK) / 2;
    if (!(dK > 0)) continue;
    sum += (dK / row.K ** 2) * Math.exp(r * T) * price;
    used += 1;
  }
  if (used < 8) return null;

  const variance = (2 / T) * sum - (1 / T) * (forward / K0 - 1) ** 2;
  if (!(variance > 0)) return null;
  const vol = Math.sqrt(variance) * 100;
  return Number.isFinite(vol) && vol > 2 && vol < 300 ? Math.round(vol * 100) / 100 : null;
}

/** 平值跨式近似：σ ≈ 跨式价格 / (0.7979 · F · √T) */
export function atmStraddleVol(chain, F, T) {
  const strikes = (chain.calls ?? []).map((x) => x.strike).filter((k) => (chain.puts ?? []).some((p) => p.strike === k));
  if (!strikes.length) return null;
  const atm = strikes.reduce((a, b) => (Math.abs(b - F) < Math.abs(a - F) ? b : a));
  const call = (chain.calls ?? []).find((x) => x.strike === atm);
  const put = (chain.puts ?? []).find((x) => x.strike === atm);
  if (!call?.last || !put?.last) return null;
  const vol = ((call.last + put.last) / (0.7979 * F * Math.sqrt(T))) * 100;
  return Number.isFinite(vol) && vol > 2 && vol < 300 ? Math.round(vol * 100) / 100 : null;
}

/**
 * 由近月期权链推算隐波指数
 * @param {Array<{month:string, chain:object}>} monthChains 各月份期权链
 * @param {Date} now
 * @param {number} targetDays 目标剩余天数（VIX 口径为 30 天）
 */
export function impliedVolFromChains(monthChains, now = new Date(), targetDays = 30) {
  const candidates = [];
  for (const item of monthChains) {
    if (!item?.chain?.calls?.length || !item?.chain?.puts?.length) continue;
    const expiry = expiryOf(item.month);
    const { days, T } = yearsToExpiry(expiry, now);
    if (days < 5 || days > 120) continue;
    candidates.push({ ...item, expiry, days, T });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => Math.abs(a.days - targetDays) - Math.abs(b.days - targetDays));
  const pick = candidates[0];

  // 用平值认购认沽价差推合成远期
  const strikes = pick.chain.calls.map((x) => x.strike).filter((k) => pick.chain.puts.some((p) => p.strike === k));
  const spotGuess = strikes.length ? strikes[Math.floor(strikes.length / 2)] : 0;
  const atmK = strikes.reduce((a, b) => (Math.abs(b - spotGuess) < Math.abs(a - spotGuess) ? b : a), strikes[0]);
  const c = pick.chain.calls.find((x) => x.strike === atmK);
  const p = pick.chain.puts.find((x) => x.strike === atmK);
  const F = atmK + ((c?.last ?? 0) - (p?.last ?? 0));

  const vixVol = vixStyleVol(pick.chain, F, pick.T);
  const atmVol = atmStraddleVol(pick.chain, F, pick.T);
  const vol = vixVol ?? atmVol;
  if (vol === null) return null;

  return {
    vol,
    method: vixVol !== null ? 'VIX 方差互换口径' : '平值跨式近似',
    month: pick.month,
    expiry: pick.expiry.toISOString().slice(0, 10),
    days: Math.round(pick.days),
    forward: Math.round(F * 100) / 100,
    strikes: strikes.length,
    candidates: candidates.map((x) => ({ month: x.month, days: Math.round(x.days) })),
  };
}
