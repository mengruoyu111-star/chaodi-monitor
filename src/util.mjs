/**
 * 通用工具函数
 */

/** 东方财富/新浪等接口常返回 GBK/GB18030 编码，自动识别并解码 */
export function decode(buffer) {
  const asUtf8 = buffer.toString('utf8');
  if (!asUtf8.includes('\uFFFD')) return asUtf8;
  try {
    return new TextDecoder('gb18030').decode(buffer);
  } catch {
    return asUtf8;
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});
const TIME_FMT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit',
});
const STAMP_FMT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** 上海时区的日期键，形如 2026-10-15 */
export const dateKey = (d = new Date()) => DATE_FMT.format(d);
/** 上海时区的时分，形如 14:03 */
export const timeKey = (d = new Date()) => TIME_FMT.format(d);
/** 上海时区完整时间戳，形如 2026-10-15 14:03:21 */
export const stamp = (d = new Date()) => STAMP_FMT.format(d).replace(/\//g, '-');

/** 上海时区当前时间的 { hour, minute, weekday } */
export function shanghaiParts(d = new Date()) {
  const s = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour12: false,
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).format(d);
  const m = /(\d{2}):(\d{2})\s*(\w+)/.exec(s);
  return { hour: +(m?.[1] ?? 0), minute: +(m?.[2] ?? 0), weekday: m?.[3] ?? 'Mon' };
}

/** 是否处于 A 股交易时段（含集合竞价与尾盘缓冲） */
export function inTradingHours(d = new Date()) {
  const { hour, minute, weekday } = shanghaiParts(d);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const t = hour * 60 + minute;
  return (t >= 9 * 60 + 15 && t <= 11 * 60 + 35) || (t >= 12 * 60 + 55 && t <= 15 * 60 + 10);
}

export function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function toNumber(value) {
  if (value === null || value === undefined || value === '' || value === '-') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);

export function stdev(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

/** 数值在数组中由小到大的分位（0-100） */
export function percentile(sortedOrRaw, value) {
  const arr = Array.isArray(sortedOrRaw) ? sortedOrRaw : [];
  if (!arr.length || !Number.isFinite(value)) return null;
  let below = 0;
  for (const v of arr) if (v <= value) below += 1;
  return round((below / arr.length) * 100, 1);
}

/** 截断数组到最近 n 项 */
export const tail = (arr, n) => (arr.length > n ? arr.slice(arr.length - n) : arr);

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 带超时的 fetch，返回解码后的文本 */
export async function fetchText(url, { referer, timeout = 15000, headers = {} } = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...(referer ? { Referer: referer } : {}),
      ...headers,
    },
    signal: AbortSignal.timeout(timeout),
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url.slice(0, 120)}`);
  }
  return decode(buffer);
}

export const fetchJson = async (url, opts) => JSON.parse(await fetchText(url, opts));
