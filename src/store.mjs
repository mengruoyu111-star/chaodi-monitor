/**
 * 配置与历史快照的持久化（纯 JSON 文件，无数据库依赖）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dateKey, stamp } from './util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'snapshots.json');
const RAW_FILE = path.join(DATA_DIR, 'raw-latest.json');

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  ensureDataDir();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** 默认配置：阈值、算法参数、手动指标状态 */
export function defaultConfig() {
  return {
    version: 1,
    refreshSeconds: 120,
    alerts: { notify: true, sound: true },

    // 红线阈值（可在网页上直接改）
    thresholds: {
      vix1000: 35,      // 中证1000 VIX ≥ 35
      margin: 2.45,     // 融资余额 ≤ 2.45 万亿
      marginAlt: 2.48,  // 空仓修正位
      imBasis: 160,     // IM 贴水 ≥ 160 点
      bigBear: 3,       // 大阴线 ≥ 3 根
      imPrice: 6600,    // IM ≤ 6600
      kc50: 1250,       // 科创50 ≤ 1250
      sentiment: 3,     // 韭圈情绪指数 < 3
      sentimentCompensation: 10, // 达到 3 但补偿超过 10 也算触发
      pcrLow: 0.85,     // 单个 PCR 低于该值记为「低估」（原文只说「低估之下」，未给具体数值，可自行校准）
      pcrNeed: 3,       // 4 个品种中几个低估即触发
    },

    // 算法参数
    params: {
      bigBear: { windowDays: 8, dropPct: 1.5, sizeBasis: 'pct' },
      volume: { volMa: 20, shrinkRatio: 0.85, shrinkDays: 3, expandRatio: 1.25, dropPct: 1.5, lookbackDays: 10, shrinkLookback: 30 },
      sizeRatio: { numerator: '0.399314', denominator: '0.399316', historyLimit: 1200, nearMaxRatio: 0.995 },
      pcr: { direction: 'below' }, // below = 低于阈值算低估；above = 高于阈值算触发
    },

    // 手动指标状态
    manual: {
      vix1000: { value: null, memo: '期权论坛的中证1000 QVIX 已停更，默认用中金所 MO 期权链自算；如需沿用原口径，可在此手动录入。' },
      sizeRatio: { locked: true, triggered: true, memo: '原文：前几天已经触发，默认红线，触发即始终有效。' },
      rateHike: { locked: false, triggered: true, memo: '今晚 CPI 公布后自动触发，默认红线；需跟踪，可能回落则去掉红线。' },
      sentiment: { locked: false, triggered: false, value: null, compensation: null, memo: '韭圈情绪指数，必须极值（小于 3）；若等于 3 但补偿超过 10 也算触发。' },
      tech: { locked: false, triggered: false, memo: '6 大科技点位无具体数据，重点看 CPO 和半导体。' },
    },

    // PCR 手动覆盖值（按品种名，留空则用自动计算结果）
    pcrValues: { 沪深300: null, 中证500: null, 中证1000: null, 科创50: null },
  };
}

/** 读取配置并与默认值合并（保证新增字段不丢） */
export function loadConfig() {
  const base = defaultConfig();
  const saved = readJson(CONFIG_FILE, null);
  if (!saved) return base;
  return {
    ...base,
    ...saved,
    alerts: { ...base.alerts, ...(saved.alerts ?? {}) },
    thresholds: { ...base.thresholds, ...(saved.thresholds ?? {}) },
    pcrValues: { ...base.pcrValues, ...(saved.pcrValues ?? {}) },
    params: {
      bigBear: { ...base.params.bigBear, ...(saved.params?.bigBear ?? {}) },
      volume: { ...base.params.volume, ...(saved.params?.volume ?? {}) },
      sizeRatio: { ...base.params.sizeRatio, ...(saved.params?.sizeRatio ?? {}) },
      pcr: { ...base.params.pcr, ...(saved.params?.pcr ?? {}) },
    },
    manual: Object.fromEntries(
      Object.entries(base.manual).map(([k, v]) => [k, { ...v, ...(saved.manual?.[k] ?? {}) }]),
    ),
  };
}

export function saveConfig(config) {
  writeJsonAtomic(CONFIG_FILE, config);
}

export function loadSnapshots() {
  const data = readJson(SNAPSHOT_FILE, { points: [] });
  return Array.isArray(data?.points) ? data.points : [];
}

export function saveSnapshots(points) {
  writeJsonAtomic(SNAPSHOT_FILE, { points });
}

export function saveRaw(raw) {
  try {
    writeJsonAtomic(RAW_FILE, raw);
  } catch {
    /* 原始数据落盘失败不影响主流程 */
  }
}

export function loadRaw() {
  return readJson(RAW_FILE, null);
}

/**
 * 追加一条历史点：
 * - 同一分钟内不重复记录
 * - 每个交易日保留当日最后一个点 + 每 10 分钟一个盘中点
 */
export function appendSnapshot(points, snapshot) {
  const last = points[points.length - 1];
  if (last && last.ts === snapshot.ts) return points;

  const sameMinute = last && last.ts.slice(0, 16) === snapshot.ts.slice(0, 16);
  if (sameMinute) return points;

  const sameDay = last && last.date === snapshot.date;
  const lastMinute = last ? Number(last.ts.slice(14, 16)) : -1;
  const curMinute = Number(snapshot.ts.slice(14, 16));
  const tenMinutesLater = sameDay && curMinute - lastMinute >= 10;

  if (sameDay && !tenMinutesLater) {
    // 覆盖当天最后一条，保证「当日最新」始终可见
    points[points.length - 1] = snapshot;
    return points;
  }

  points.push(snapshot);
  const MAX = 5000;
  return points.length > MAX ? points.slice(points.length - MAX) : points;
}

export function makeSnapshot({ items, summary, observedAt }) {
  const ts = stamp();
  return {
    ts,
    date: dateKey(),
    count: summary.triggered,
    total: summary.total,
    score: summary.score,
    level: summary.level,
    values: Object.fromEntries(items.map((i) => [i.key, i.value ?? null])),
    flags: Object.fromEntries(items.map((i) => [i.key, i.triggered === true])),
    status: Object.fromEntries(items.map((i) => [i.key, i.status])),
    observedAt: observedAt ?? ts,
  };
}
