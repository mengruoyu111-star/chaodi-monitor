/**
 * 静态构建：抓一次数据 → 判定 12 条红线 → 输出可直接托管的 dist/
 *
 *   node scripts/snapshot.mjs
 *
 * 产物：
 *   dist/index.html, dist/styles.css, dist/app.js
 *   dist/data/state.json     页面读取的全部数据（只读，无任何写接口）
 *   data/history.json        完整历史（会被提交回仓库，供下次构建续写）
 *
 * 这个脚本同时被本地 `npm run build` 和 GitHub Actions 定时任务调用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectRaw } from '../src/providers.mjs';
import { CATALOG, evaluateAll } from '../src/indicators.mjs';
import { appendSnapshot, loadConfig, makeSnapshot } from '../src/store.mjs';
import { inTradingHours, stamp } from '../src/util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PUBLIC_DIR = path.join(ROOT, 'public');
/**
 * 构建用的历史库。和本地服务的 data/snapshots.json 分开：
 * 这个文件会被提交回仓库，好让云端构建跨次累积历史。
 */
const HISTORY_FILE = path.join(ROOT, 'data', 'history.json');

function readHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (Array.isArray(data?.points) && data.points.length) return data.points;
  } catch { /* 文件不存在或损坏，走下面的种子逻辑 */ }

  // 首次构建：用本地服务已经攒下的历史做种子，免得线上趋势图一开始只有 1 个点
  try {
    const local = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'snapshots.json'), 'utf8'));
    if (Array.isArray(local?.points) && local.points.length) {
      console.log(`  首次构建，用本地历史 ${local.points.length} 个点做种子`);
      return local.points;
    }
  } catch { /* 没有本地历史就算了 */ }

  return [];
}

function writeHistory(points) {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify({ points }, null, 2), 'utf8');
}

/** 页面加载的历史点只保留画图必需的三列，控制体积 */
const slim = (points) => points.map((p) => ({ ts: p.ts, date: p.date, count: p.count }));

function copyStatic() {
  fs.mkdirSync(path.join(DIST, 'data'), { recursive: true });
  for (const file of ['index.html', 'styles.css', 'app.js']) {
    fs.copyFileSync(path.join(PUBLIC_DIR, file), path.join(DIST, file));
  }
  // 静态模式下不需要本地服务的前端资源清单
  fs.writeFileSync(path.join(DIST, '.nojekyll'), '', 'utf8');
}

async function main() {
  const config = loadConfig();
  console.log(`[${stamp()}] 开始抓取数据…`);

  const t0 = Date.now();
  const raw = await collectRaw(config);
  const result = evaluateAll(config, raw);
  const elapsed = Date.now() - t0;

  if (raw.errors.length) {
    console.log(`  数据源异常 ${raw.errors.length} 个：`);
    for (const e of raw.errors) console.log(`    - ${e.source}: ${e.message}`);
  }
  console.log(
    `[${stamp()}] 判定完成（${elapsed}ms）红线 ${result.summary.triggered}/${result.summary.total}` +
    `　${result.summary.level}　评分 ${result.summary.score}`,
  );

  // 历史：读旧的、追加新的、写回仓库（云端构建靠它跨次累积）
  const points = appendSnapshot(readHistory(), makeSnapshot({
    items: result.items,
    summary: result.summary,
    observedAt: result.observedAt,
  }));
  writeHistory(points);

  copyStatic();

  const payload = {
    mode: 'static',
    builtAt: stamp(),
    buildElapsedMs: elapsed,
    config,
    catalog: CATALOG,
    state: {
      status: raw.errors.length && result.summary.unknown >= 7 ? 'error' : 'ok',
      updatedAt: result.observedAt,
      builtAt: stamp(),
      marketOpen: inTradingHours(),
      refreshCount: points.length,
      lastError: null,
      serverTime: stamp(),
    },
    result,
    rawMeta: {
      fetchedAt: stamp(raw.fetchedAt),
      elapsedMs: elapsed,
      errors: raw.errors ?? [],
      pcrMetric: raw.pcrMetric ?? null,
      impliedVol: raw.impliedVol ?? null,
      counts: raw.counts ?? {},
    },
    history: slim(points.slice(-2000)),
  };

  const stateFile = path.join(DIST, 'data', 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(payload), 'utf8');
  const size = fs.statSync(stateFile).size;
  console.log(`  产物：dist/data/state.json（${(size / 1024).toFixed(1)} KB，含 ${payload.history.length} 个历史点）`);
  console.log(`  历史库：data/history.json（${points.length} 个点）`);

  // 数据几乎全缺时视为构建失败，避免把空页面推到线上
  if (result.summary.unknown >= 7) {
    console.error(`\n[失败] 12 个指标里有 ${result.summary.unknown} 个拿不到数据，疑似网络/接口不可用。`);
    console.error('       已生成产物但不建议部署，请检查上面列出的数据源异常。');
    process.exit(1);
  }

  console.log(`[${stamp()}] 构建完成 → ${DIST}`);
}

main().catch((err) => {
  console.error(`[失败] ${err?.stack ?? err}`);
  process.exit(1);
});
