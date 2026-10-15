/**
 * 抄底红线监测器 —— 本地服务
 *
 * 仅使用 Node 内置模块，无第三方依赖。
 *   node server.mjs            启动服务并常驻刷新
 *   node server.mjs --once     只刷新一次，打印结果后退出
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { clearCache, collectRaw } from './src/providers.mjs';
import { CATALOG, evaluateAll } from './src/indicators.mjs';
import {
  appendSnapshot, defaultConfig, ensureDataDir, loadConfig, loadSnapshots,
  makeSnapshot, saveConfig, saveRaw, saveSnapshots,
} from './src/store.mjs';
import { inTradingHours, stamp } from './src/util.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const ONCE = process.argv.includes('--once');

/* ------------------------------ 运行时状态 ------------------------------ */
let config = loadConfig();
let snapshots = loadSnapshots();

const state = {
  status: 'idle',        // idle | refreshing | ok | error
  result: null,          // evaluateAll 的输出
  updatedAt: null,
  lastError: null,
  refreshCount: 0,
  nextRefreshAt: null,
  startedAt: stamp(),
};

/** 最近一次的原始数据摘要，用于页面「数据源」面板 */
let rawMeta = null;
/** 最近一次的完整原始数据，改阈值时可原地重算，不必重新联网 */
let lastRaw = null;

/* -------------------------------- 刷新 -------------------------------- */
let refreshing = null;

async function refresh({ reason = 'schedule' } = {}) {
  if (refreshing) return refreshing;
  state.status = 'refreshing';
  refreshing = (async () => {
    const t0 = Date.now();
    try {
      clearCache();
      const raw = await collectRaw(config);
      lastRaw = raw;
      const result = evaluateAll(config, raw);
      const snapshot = makeSnapshot({
        items: result.items,
        summary: result.summary,
        observedAt: result.observedAt,
      });

      snapshots = appendSnapshot(snapshots, snapshot);
      saveSnapshots(snapshots);

      rawMeta = {
        fetchedAt: stamp(raw.fetchedAt),
        elapsedMs: Date.now() - t0,
        errors: raw.errors ?? [],
        pcrMetric: raw.pcrMetric ?? null,
        impliedVol: raw.impliedVol ?? null,
        counts: raw.counts ?? {},
      };
      saveRaw({
        fetchedAt: raw.fetchedAt,
        quotes: raw.quotes,
        margin: (raw.margin ?? []).slice(0, 5),
        qvix: raw.qvix ? { latestDate: raw.qvix.latestDate, series: raw.qvix.series } : null,
        impliedVol: raw.impliedVol,
        pcr: raw.pcr,
        pcrMetric: raw.pcrMetric,
        errors: raw.errors,
      });

      state.result = result;
      state.updatedAt = stamp();
      state.lastError = null;
      state.refreshCount += 1;
      state.status = 'ok';
      console.log(
        `[${state.updatedAt}] 刷新完成（${reason}，${Date.now() - t0}ms）` +
        ` 红线 ${result.summary.triggered}/${result.summary.total}` +
        (raw.errors.length ? ` ｜ ${raw.errors.length} 个数据源异常` : ''),
      );
      return result;
    } catch (err) {
      state.status = 'error';
      state.lastError = String(err?.message ?? err);
      console.error(`[${stamp()}] 刷新失败：${state.lastError}`);
      return null;
    } finally {
      refreshing = null;
      scheduleNext();
    }
  })();
  return refreshing;
}

/* ------------------------------- 调度器 ------------------------------- */
let timer = null;
function scheduleNext() {
  if (ONCE) return;
  clearTimeout(timer);
  const trading = inTradingHours();
  const seconds = trading
    ? Math.max(30, Number(config.refreshSeconds) || 120)
    : 600;
  state.marketOpen = trading;
  state.nextRefreshAt = new Date(Date.now() + seconds * 1000).toISOString();
  timer = setTimeout(() => refresh({ reason: trading ? '盘中' : '非交易时段' }), seconds * 1000);
  timer.unref?.();
}

/* ------------------------------ HTTP 服务 ------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 512 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 只允许写入白名单字段，避免配置被写坏 */
function applyConfigPatch(patch) {
  const next = structuredClone(config);
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);

  if (patch.thresholds && typeof patch.thresholds === 'object') {
    for (const [k, v] of Object.entries(patch.thresholds)) {
      if (!(k in next.thresholds)) continue;
      const n = num(v);
      if (n !== undefined) next.thresholds[k] = n;
    }
  }
  if (patch.params && typeof patch.params === 'object') {
    for (const group of ['bigBear', 'volume', 'sizeRatio', 'pcr']) {
      const incoming = patch.params[group];
      if (!incoming || typeof incoming !== 'object') continue;
      for (const [k, v] of Object.entries(incoming)) {
        if (!(k in next.params[group])) continue;
        if (typeof next.params[group][k] === 'number') {
          const n = num(v);
          if (n !== undefined) next.params[group][k] = n;
        } else {
          next.params[group][k] = v;
        }
      }
    }
  }
  if (patch.manual && typeof patch.manual === 'object') {
    for (const [key, incoming] of Object.entries(patch.manual)) {
      if (!next.manual[key] || !incoming || typeof incoming !== 'object') continue;
      const target = next.manual[key];
      if ('triggered' in incoming) target.triggered = !!incoming.triggered;
      if ('locked' in incoming) target.locked = !!incoming.locked;
      if ('value' in incoming) target.value = incoming.value === '' || incoming.value === null ? null : num(incoming.value);
      if ('compensation' in incoming) {
        target.compensation = incoming.compensation === '' || incoming.compensation === null ? null : num(incoming.compensation);
      }
      if ('memo' in incoming) target.memo = String(incoming.memo ?? '').slice(0, 500);
      target.updatedAt = stamp();
    }
  }
  if (patch.alerts && typeof patch.alerts === 'object') {
    next.alerts = { ...next.alerts, ...patch.alerts };
  }
  if (patch.pcrValues && typeof patch.pcrValues === 'object') {
    for (const [key, v] of Object.entries(patch.pcrValues)) {
      if (!(key in next.pcrValues)) continue;
      next.pcrValues[key] = v === '' || v === null ? null : num(v) ?? null;
    }
  }
  const rs = num(patch.refreshSeconds);
  if (rs !== undefined) next.refreshSeconds = Math.min(3600, Math.max(30, rs));
  return next;
}

function snapshotPayload() {
  return {
    config,
    catalog: CATALOG,
    state: {
      status: state.status,
      updatedAt: state.updatedAt,
      lastError: state.lastError,
      refreshCount: state.refreshCount,
      marketOpen: inTradingHours(),
      nextRefreshAt: state.nextRefreshAt,
      startedAt: state.startedAt,
      serverTime: stamp(),
    },
    result: state.result,
    rawMeta,
    history: snapshots,
  };
}

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, rel);
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const stat = await fs.promises.stat(target);
    if (stat.isDirectory()) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const p = url.pathname;

  try {
    if (p === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, snapshotPayload());
    }

    if (p === '/api/refresh' && req.method === 'POST') {
      const result = await refresh({ reason: '手动' });
      return sendJson(res, result ? 200 : 502, { ok: !!result, ...snapshotPayload() });
    }

    if (p === '/api/config' && (req.method === 'PATCH' || req.method === 'POST')) {
      const patch = await readBody(req);
      config = applyConfigPatch(patch);
      saveConfig(config);
      // 用同一份原始数据原地重算，阈值改动立刻在页面上生效
      if (lastRaw) {
        const result = evaluateAll(config, lastRaw);
        state.result = result;
        snapshots = appendSnapshot(snapshots, makeSnapshot({
          items: result.items, summary: result.summary, observedAt: result.observedAt,
        }));
        saveSnapshots(snapshots);
      }
      return sendJson(res, 200, { ok: true, ...snapshotPayload() });
    }

    if (p === '/api/config/reset' && req.method === 'POST') {
      config = defaultConfig();
      saveConfig(config);
      return sendJson(res, 200, { ok: true, ...snapshotPayload() });
    }

    if (p === '/api/history' && req.method === 'DELETE') {
      snapshots = [];
      saveSnapshots(snapshots);
      return sendJson(res, 200, { ok: true, ...snapshotPayload() });
    }

    if (p === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, status: state.status, updatedAt: state.updatedAt });
    }

    if (req.method !== 'GET') {
      return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
    }

    return serveStatic(req, res, p);
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
  }
});

/* --------------------------------- 启动 --------------------------------- */
ensureDataDir();

if (ONCE) {
  const result = await refresh({ reason: '命令行' });
  if (result) {
    console.log('\n指标详情：');
    for (const item of result.items) {
      const flag = item.triggered === true ? '红线' : item.triggered === null ? '无数据' : '  —  ';
      console.log(`  ${String(item.id).padStart(2)}. [${flag}] ${item.name.padEnd(14)} ${String(item.valueText).padEnd(14)} ${item.thresholdText}`);
    }
    console.log(`\n红线合计 ${result.summary.triggered}/${result.summary.total}　${result.summary.level}　${result.summary.action}`);
  }
  process.exit(result ? 0 : 1);
} else {
  server.listen(PORT, HOST, () => {
    console.log('抄底红线监测器已启动');
    console.log(`  网址：http://${HOST}:${PORT}`);
    console.log(`  数据目录：${path.join(ROOT, 'data')}`);
    console.log(`  刷新间隔：盘中 ${config.refreshSeconds}s ／ 非交易时段 600s\n`);
    refresh({ reason: '启动' });
  });
}

process.on('SIGINT', () => {
  console.log('\n正在退出…');
  clearTimeout(timer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});
