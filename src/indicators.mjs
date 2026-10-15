/**
 * 12 个数据指标的红线判定引擎
 *
 * 规则来源：星球「Coming 星主」2026/10/15 的《12 个数据指标 + 红线阈值》
 * 每条指标返回统一结构，UI 直接渲染。
 */
import { SECID } from './providers.mjs';
import { mean, round, stamp, tail, toNumber } from './util.mjs';

export const CATALOG = [
  { id: 1, key: 'vix1000', name: '中证1000 VIX', short: '波动率', mode: 'auto', unit: '' },
  { id: 2, key: 'margin', name: '融资余额', short: '杠杆资金', mode: 'auto', unit: '万亿' },
  { id: 3, key: 'imBasis', name: 'IM 贴水', short: '期货贴水', mode: 'auto', unit: '点' },
  { id: 4, key: 'bigBear', name: '大阴线', short: 'K线形态', mode: 'auto', unit: '根' },
  { id: 5, key: 'volume', name: '成交量 缩+放', short: '量能', mode: 'auto', unit: '' },
  { id: 6, key: 'sizeRatio', name: '大盘小盘比 MAX', short: '风格极值', mode: 'auto', unit: '' },
  { id: 7, key: 'rateHike', name: '6月4次加息率提升', short: '宏观', mode: 'manual', unit: '' },
  { id: 8, key: 'imPrice', name: 'IM 6600', short: '期指点位', mode: 'auto', unit: '' },
  { id: 9, key: 'kc50', name: '科创50 1250', short: '指数点位', mode: 'auto', unit: '' },
  { id: 10, key: 'sentiment', name: '韭圈情绪指数', short: '情绪', mode: 'manual', unit: '' },
  { id: 11, key: 'pcr', name: 'PCR 3/4', short: '期权比', mode: 'auto', unit: '' },
  { id: 12, key: 'tech', name: '6大科技点位', short: 'CPO/半导体', mode: 'manual', unit: '' },
];

const STATUS = { HIT: 'triggered', SAFE: 'safe', UNKNOWN: 'unknown' };

/* ------------------------------- 工具 ------------------------------- */

function makeItem(meta, patch) {
  return {
    id: meta.id,
    key: meta.key,
    name: meta.name,
    short: meta.short,
    mode: meta.mode,
    unit: meta.unit,
    value: null,
    valueText: '—',
    threshold: null,
    thresholdText: '—',
    compare: null,
    triggered: null,
    status: STATUS.UNKNOWN,
    detail: '',
    rows: [],
    source: '',
    observedAt: null,
    ...patch,
  };
}

/** 判断是否触发；compare 描述触发方向 */
function hit(compare, value, threshold) {
  if (!Number.isFinite(value) || !Number.isFinite(threshold)) return null;
  switch (compare) {
    case 'gte': return value >= threshold;
    case 'lte': return value <= threshold;
    case 'lt': return value < threshold;
    case 'gt': return value > threshold;
    default: return null;
  }
}

const fmt = (v, digits = 2) => (Number.isFinite(v) ? v.toFixed(digits) : '—');
const signed = (v, digits = 2) => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(digits)}` : '—');

/* --------------------------- 1. 中证1000 VIX --------------------------- */
function evalVix1000(config) {
  return (raw) => {
    const meta = CATALOG[0];
    const threshold = config.thresholds.vix1000;
    const manual = config.manual.vix1000 ?? {};
    const iv = raw.impliedVol;
    const refSeries = raw.qvix?.series?.['中证1000股指（已停更）'] ?? [];
    const ref = refSeries[refSeries.length - 1];

    const manualValue = toNumber(manual.value);
    const value = Number.isFinite(manualValue) ? manualValue : iv?.vol ?? null;

    if (!Number.isFinite(value)) {
      return makeItem(meta, {
        threshold, thresholdText: `≥ ${threshold}`, compare: 'gte',
        detail: '未能取到中证1000 期权链，无法计算隐含波动率；可在设置里手动录入。',
        source: '中金所 MO 期权链（自算）',
        rows: ref ? [{ label: '期权论坛 QVIX（已停更）', value: `${ref.date} 收 ${fmt(ref.close)}` }] : [],
      });
    }

    const triggered = hit('gte', value, threshold);
    const rows = [];
    if (Number.isFinite(manualValue)) {
      rows.push({ label: '数据方式', value: '手动录入（覆盖自动计算）' });
    } else if (iv) {
      rows.push({ label: '计算口径', value: `${iv.method}，剩余 ${iv.days} 天` });
      rows.push({ label: '选取合约', value: `${iv.month}（到期 ${iv.expiry}）` });
      rows.push({ label: '合成远期', value: fmt(iv.forward) });
      rows.push({ label: '行权价档数', value: `${iv.strikes} 档` });
    }
    rows.push({ label: '距阈值', value: signed(value - threshold) });
    rows.push({
      label: '期权论坛 QVIX',
      value: ref ? `最后有效值 ${ref.date} 收 ${fmt(ref.close)}（源已停更）` : '无有效值',
    });

    return makeItem(meta, {
      value: round(value, 2), valueText: fmt(value),
      threshold, thresholdText: `≥ ${threshold}`, compare: 'gte',
      triggered, status: triggered ? STATUS.HIT : STATUS.SAFE,
      detail: triggered
        ? `中证1000 隐含波动率 ${fmt(value)} 已达红线 ${threshold}，恐慌情绪进入极值区。`
        : `中证1000 隐含波动率 ${fmt(value)}，距红线 ${threshold} 还差 ${fmt(threshold - value)}。`,
      rows,
      source: Number.isFinite(manualValue) ? '手动录入' : `自算（${iv?.source ?? '中金所 MO 期权链'}）`,
      observedAt: stamp(),
    });
  };
}

/* ---------------------------- 2. 融资余额 ---------------------------- */
function evalMargin(config) {
  return (raw) => {
    const meta = CATALOG[1];
    const threshold = config.thresholds.margin;
    const alt = config.thresholds.marginAlt;
    const list = raw.margin ?? [];
    const latest = list[0];
    if (!latest?.financing) {
      return makeItem(meta, {
        threshold, thresholdText: `≤ ${threshold} 万亿`, compare: 'lte',
        detail: '未取到融资融券数据。', source: '东方财富 数据中心',
      });
    }
    const value = latest.financing / 1e12; // 元 -> 万亿
    const prev = list[1];
    const triggered = hit('lte', value, threshold);
    const gapYi = (value - threshold) * 10000; // 亿元
    const rows = [
      { label: '数据日期', value: latest.date },
      { label: '较前一日', value: prev ? `${signed((value - prev.financing / 1e12) * 10000, 1)} 亿` : '—' },
      { label: '距 2.45 阈值', value: `${fmt(gapYi, 1)} 亿` },
      { label: '空仓修正位', value: `${alt} 万亿` },
      { label: '融资融券总额', value: latest.total ? `${fmt(latest.total / 1e12, 4)} 万亿` : '—' },
    ];
    return makeItem(meta, {
      value: round(value, 4), valueText: `${fmt(value, 4)} 万亿`,
      threshold, thresholdText: `≤ ${threshold} 万亿`, compare: 'lte',
      triggered, status: triggered ? STATUS.HIT : STATUS.SAFE,
      detail: triggered
        ? `融资余额已降至 ${fmt(value, 4)} 万亿，达到红线 ${threshold} 万亿，继续下杀的潜在利润有限。`
        : `融资余额 ${fmt(value, 4)} 万亿，还需再降 ${fmt(gapYi, 1)} 亿才到红线 ${threshold} 万亿。`,
      rows,
      source: '东方财富 数据中心（融资融券历史）',
      observedAt: latest.date,
    });
  };
}

/* ----------------------------- 3. IM 贴水 ----------------------------- */
function evalImBasis(config) {
  return (raw) => {
    const meta = CATALOG[2];
    const threshold = config.thresholds.imBasis;
    const spot = raw.quotes[SECID.csi1000];
    const main = raw.quotes[SECID.imMain];
    const front = raw.quotes[SECID.imFront];
    const next = raw.quotes[SECID.imNext];
    if (!spot?.price || !main?.price) {
      return makeItem(meta, {
        threshold, thresholdText: `≥ ${threshold} 点`, compare: 'gte',
        detail: '未取到中证1000指数或IM主力合约行情。', source: '东方财富 行情',
      });
    }
    const value = round(spot.price - main.price, 2);
    const triggered = hit('gte', value, threshold);
    const rows = [
      { label: '中证1000现货', value: fmt(spot.price) },
      { label: 'IM 主力合约', value: fmt(main.price) },
      { label: `IM 当月 ${front ? fmt(front.price) : '—'}`, value: front ? `基差 ${signed(spot.price - front.price)}` : '—' },
      { label: `IM 下月 ${next ? fmt(next.price) : '—'}`, value: next ? `基差 ${signed(spot.price - next.price)}` : '—' },
    ];
    return makeItem(meta, {
      value, valueText: `${fmt(value)} 点`,
      threshold, thresholdText: `≥ ${threshold} 点`, compare: 'gte',
      triggered, status: triggered ? STATUS.HIT : STATUS.SAFE,
      detail: triggered
        ? `IM 主力贴水扩大到 ${fmt(value)} 点，达到红线 ${threshold} 点，是恐慌盘出现的标志。`
        : `IM 主力贴水 ${fmt(value)} 点，距红线 ${threshold} 点还差 ${fmt(threshold - value)} 点。`,
      rows,
      source: '东方财富 行情（中证1000 + IM 主力合约）',
      observedAt: stamp(),
    });
  };
}

/* ---------------------------- 4. 大阴线 ---------------------------- */
function candleMagnitude(k, sizeBasis) {
  if (sizeBasis === 'body') {
    // 实体跌幅：开盘高于收盘时的实体幅度
    if (!(k.open > k.close)) return 0;
    return ((k.open - k.close) / k.open) * 100;
  }
  return -Math.min(0, k.pct ?? 0);
}

function evalBigBear(config) {
  return (raw) => {
    const meta = CATALOG[3];
    const need = config.thresholds.bigBear;
    const { windowDays, dropPct, sizeBasis } = config.params.bigBear;
    const kline = raw.kline?.csi1000 ?? [];
    if (kline.length < windowDays + 1) {
      return makeItem(meta, {
        threshold: need, thresholdText: `≥ ${need} 根`, compare: 'gte',
        detail: '未取到中证1000日K线。', source: '东方财富 日K线',
      });
    }
    const recent = tail(kline, windowDays);
    const bigs = recent
      .map((k, i) => ({ ...k, mag: candleMagnitude(k, sizeBasis), order: i }))
      .filter((k) => k.mag >= dropPct);

    const mags = bigs.map((b) => b.mag);
    const maxMag = mags.length ? Math.max(...mags) : 0;
    const firstIsMax = bigs.length > 0 && bigs[0].mag >= maxMag - 1e-6;
    const enough = bigs.length >= need;
    const triggered = enough && !firstIsMax;

    const basisText = sizeBasis === 'body' ? '实体跌幅' : '涨跌幅';
    const rows = bigs.map((b) => ({
      label: b.date,
      value: `${basisText} -${b.mag.toFixed(2)}%${b.mag >= maxMag - 1e-6 ? '（最大）' : ''}`,
      tone: b.mag >= maxMag - 1e-6 ? 'warn' : undefined,
    }));
    rows.push({ label: `窗口`, value: `最近 ${windowDays} 个交易日，单日${basisText} ≥ ${dropPct}%` });

    let detail;
    if (triggered) {
      detail = `最近 ${windowDays} 个交易日出现 ${bigs.length} 根大阴线（≥${need} 根），且最大的一根不是第一根，形态满足硬性指标。`;
    } else if (!enough) {
      detail = `最近 ${windowDays} 个交易日只有 ${bigs.length} 根大阴线，未达到 ${need} 根的硬性要求。`;
    } else {
      detail = `大阴线已有 ${bigs.length} 根，但最大的一根是第一根（下跌仍在初期），不满足红线条件。`;
    }

    return makeItem(meta, {
      value: bigs.length, valueText: `${bigs.length} 根`,
      threshold: need, thresholdText: `≥ ${need} 根`, compare: 'gte',
      triggered, status: triggered ? STATUS.HIT : STATUS.SAFE,
      detail, rows,
      source: '东方财富 中证1000 日K线',
      observedAt: recent[recent.length - 1]?.date ?? null,
    });
  };
}

/* ------------------------- 5. 成交量 缩+放 ------------------------- */
function evalVolume(config) {
  return (raw) => {
    const meta = CATALOG[4];
    const p = config.params.volume;
    const kline = raw.kline?.csi1000 ?? [];
    if (kline.length < p.volMa + p.lookbackDays + 5) {
      return makeItem(meta, {
        thresholdText: '缩量后放量大跌', compare: 'bool',
        detail: '日K线数据不足，无法判断量能形态。', source: '东方财富 日K线',
      });
    }

    // 用「当日前 volMa 日均量」作基准，避免未来函数
    const withMa = kline.map((k, i) => {
      const base = i >= p.volMa ? mean(kline.slice(i - p.volMa, i).map((x) => x.volume)) : null;
      return {
        ...k,
        volMa: base,
        shrink: base ? k.volume < base * p.shrinkRatio : false,
        expandDown: base ? k.pct <= -p.dropPct && k.volume >= base * p.expandRatio : false,
        volRatio: base ? k.volume / base : null,
      };
    });

    const len = withMa.length;
    let expandIdx = -1;
    for (let i = len - 1; i >= Math.max(0, len - p.lookbackDays); i -= 1) {
      if (withMa[i].expandDown) { expandIdx = i; break; }
    }

    const shrinkStart = expandIdx >= 0 ? Math.max(0, expandIdx - p.shrinkLookback) : Math.max(0, len - p.shrinkLookback);
    const shrinkEnd = expandIdx >= 0 ? expandIdx : len;
    const shrinkDaysFound = withMa.slice(shrinkStart, shrinkEnd).filter((k) => k.shrink).length;
    const triggered = expandIdx >= 0 && shrinkDaysFound >= p.shrinkDays;

    const expandDay = expandIdx >= 0 ? withMa[expandIdx] : null;
    const rows = [
      { label: '均量基准', value: `前 ${p.volMa} 日均量` },
      { label: `缩量天数`, value: `${shrinkDaysFound} 天（低于均量 ${Math.round(p.shrinkRatio * 100)}%）` },
      {
        label: '放量大跌',
        value: expandDay
          ? `${expandDay.date}　${expandDay.pct.toFixed(2)}%　量比 ${fmt(expandDay.volRatio)}`
          : `最近 ${p.lookbackDays} 日未出现`,
      },
      { label: '判定标准', value: `跌幅 ≤ -${p.dropPct}% 且量 ≥ 均量 ${Math.round(p.expandRatio * 100)}%` },
    ];

    let detail;
    if (triggered) {
      detail = `已出现 ${shrinkDaysFound} 天缩量，并在 ${expandDay.date} 出现「大跌 + 放量」（量比 ${fmt(expandDay.volRatio)}），筹码完成弱手到强手的交换。`;
    } else if (!expandDay) {
      detail = `最近 ${p.lookbackDays} 个交易日还没有出现「大跌 + 放量」，缩量过程（${shrinkDaysFound} 天）尚未以放量收尾。`;
    } else {
      detail = `已出现放量大跌（${expandDay.date}），但此前缩量天数仅 ${shrinkDaysFound} 天，不足 ${p.shrinkDays} 天，缩放过程不完整。`;
    }

    return makeItem(meta, {
      value: triggered ? 1 : 0,
      valueText: triggered ? '已满足' : '未满足',
      thresholdText: '缩量后放量大跌', compare: 'bool',
      triggered, status: triggered ? STATUS.HIT : STATUS.SAFE,
      detail, rows,
      source: '东方财富 中证1000 日K线（量价）',
      observedAt: withMa[withMa.length - 1]?.date ?? null,
    });
  };
}

/* ------------------------ 6. 大盘小盘比 MAX ------------------------ */
function evalSizeRatio(config) {
  return (raw) => {
    const meta = CATALOG[5];
    const p = config.params.sizeRatio;
    const manual = config.manual.sizeRatio ?? {};
    const big = raw.kline?.big ?? [];
    const small = raw.kline?.small ?? [];
    const nameOf = { '0.399314': '巨潮大盘/巨潮小盘', '1.000300': '沪深300/中证2000', '1.000016': '上证50/中证1000' };

    if (big.length < 30 || small.length < 30) {
      return makeItem(meta, {
        mode: manual.locked ? 'manual' : 'auto',
        thresholdText: '创历史新高', compare: 'gt',
        triggered: manual.locked ? true : null,
        status: manual.locked ? STATUS.HIT : STATUS.UNKNOWN,
        detail: manual.memo || '指数历史数据不足，未取到比值序列。',
        source: '东方财富 指数日K线',
      });
    }

    const smallMap = new Map(small.map((k) => [k.date, k.close]));
    const ratios = big
      .filter((k) => smallMap.has(k.date))
      .map((k) => ({ date: k.date, value: k.close / smallMap.get(k.date) }));
    const values = ratios.map((r) => r.value);
    const cur = ratios[ratios.length - 1];
    const max = Math.max(...values);
    const maxIdx = values.indexOf(max);
    const ma20 = mean(tail(values, 20));
    const gapToMax = ((cur.value / max) - 1) * 100;
    const atMax = cur.value >= max * p.nearMaxRatio;

    const computedTriggered = atMax;
    const triggered = manual.locked ? true : computedTriggered;

    const rows = [
      { label: '比值对', value: nameOf[`${p.numerator}`] ?? `${p.numerator} / ${p.denominator}` },
      { label: '当前比值', value: fmt(cur.value, 4) },
      { label: '历史最高', value: `${fmt(max, 4)}（${ratios[maxIdx]?.date}）` },
      { label: '距最高', value: `${signed(gapToMax)}%` },
      { label: '20日均值', value: fmt(ma20, 4) },
      { label: '样本区间', value: `${ratios[0]?.date} ~ ${cur.date}（${ratios.length} 个交易日）` },
    ];

    const detail = manual.locked
      ? `${manual.memo || '已手动锁定为触发状态。'}（参考：当前比值 ${fmt(cur.value, 4)}，距历史最高 ${signed(gapToMax)}%）`
      : computedTriggered
        ? `大盘/小盘比值 ${fmt(cur.value, 4)} 已创样本区间新高，风格极值出现。`
        : `大盘/小盘比值 ${fmt(cur.value, 4)}，距历史最高还差 ${fmt(Math.abs(gapToMax))}%。`;

    return makeItem(meta, {
      mode: manual.locked ? 'manual' : 'auto',
      value: round(cur.value, 4), valueText: fmt(cur.value, 4),
      thresholdText: '创历史新高', compare: 'gt',
      triggered, status: triggered ? STATUS.HIT : STATUS.SAFE,
      detail, rows,
      source: '东方财富 指数日K线（比值自算）',
      observedAt: cur.date,
      manuallyLocked: !!manual.locked,
    });
  };
}

/* --------------------- 7. 6月4次加息率提升（手动） --------------------- */
function evalRateHike(config) {
  return () => {
    const meta = CATALOG[6];
    const m = config.manual.rateHike ?? {};
    return makeItem(meta, {
      mode: 'manual',
      value: m.triggered ? 1 : 0,
      valueText: m.triggered ? '已触发' : '未触发',
      thresholdText: '默认红线（需跟踪）', compare: 'manual',
      triggered: !!m.triggered, status: m.triggered ? STATUS.HIT : STATUS.SAFE,
      detail: m.memo || 'CPI 公布后自动触发，默认红线；需跟踪观察，若回落要去掉红线。',
      rows: [
        { label: '触发依据', value: 'CPI 公布 → 加息预期提升' },
        { label: '维护方式', value: '手动切换（可能回落）' },
      ],
      source: '手动维护',
      observedAt: m.updatedAt ?? null,
    });
  };
}

/* ----------------------------- 8. IM 6600 ----------------------------- */
function evalImPrice(config) {
  return (raw) => {
    const meta = CATALOG[7];
    const threshold = config.thresholds.imPrice;
    const main = raw.quotes[SECID.imMain];
    const front = raw.quotes[SECID.imFront];
    if (!main?.price) {
      return makeItem(meta, {
        threshold, thresholdText: `≤ ${threshold}`, compare: 'lte',
        detail: '未取到 IM 主力合约行情。', source: '东方财富 行情',
      });
    }
    const value = main.price;
    const triggered = hit('lte', value, threshold);
    const rows = [
      { label: 'IM 主力', value: fmt(value) },
      { label: 'IM 当月连续', value: front ? fmt(front.price) : '—' },
      { label: '当日涨跌', value: `${signed(main.pct)}%` },
      { label: '距阈值', value: `${signed(value - threshold)}` },
      { label: '测算区间', value: '6400 ~ 6700（5 种方法）' },
    ];
    return makeItem(meta, {
      value: round(value, 1), valueText: fmt(value, 1),
      threshold, thresholdText: `≤ ${threshold}`, compare: 'lte',
      triggered, status: triggered ? STATUS.HIT : STATUS.SAFE,
      detail: triggered
        ? `IM 主力 ${fmt(value, 1)} 已跌到红线 ${threshold} 之下，进入测算的底部区间。`
        : `IM 主力 ${fmt(value, 1)}，距红线 ${threshold} 还有 ${fmt(value - threshold, 1)} 点。`,
      rows,
      source: '东方财富 行情（IM 主力合约）',
      observedAt: stamp(),
    });
  };
}

/* ---------------------------- 9. 科创50 ---------------------------- */
function evalKc50(config) {
  return (raw) => {
    const meta = CATALOG[8];
    const threshold = config.thresholds.kc50;
    const q = raw.quotes[SECID.star50];
    if (!q?.price) {
      return makeItem(meta, {
        threshold, thresholdText: `≤ ${threshold}`, compare: 'lte',
        detail: '未取到科创50行情。', source: '东方财富 行情',
      });
    }
    const value = q.price;
    const triggered = hit('lte', value, threshold);
    const rows = [
      { label: '最新点位', value: fmt(value) },
      { label: '当日涨跌', value: `${signed(q.pct)}%` },
      { label: '距阈值', value: `${signed(value - threshold)}（${fmt(((value - threshold) / threshold) * 100)}%）` },
      { label: '测算区间', value: '1200 ~ 1300（3 种方法）' },
    ];
    return makeItem(meta, {
      value: round(value, 2), valueText: fmt(value),
      threshold, thresholdText: `≤ ${threshold}`, compare: 'lte',
      triggered, status: triggered ? STATUS.HIT : STATUS.SAFE,
      detail: triggered
        ? `科创50 ${fmt(value)} 已跌破红线 ${threshold}。`
        : `科创50 ${fmt(value)}，距红线 ${threshold} 还有 ${fmt(value - threshold)} 点（${fmt(((value - threshold) / threshold) * 100)}%）。`,
      rows,
      source: '东方财富 行情（科创50 指数）',
      observedAt: stamp(),
    });
  };
}

/* --------------------- 10. 韭圈情绪指数（手动为主） --------------------- */
function evalSentiment(config) {
  return () => {
    const meta = CATALOG[9];
    const threshold = config.thresholds.sentiment;
    const compThreshold = config.thresholds.sentimentCompensation;
    const m = config.manual.sentiment ?? {};
    const value = toNumber(m.value);
    const comp = toNumber(m.compensation);

    const extreme = Number.isFinite(value) && value < threshold;
    const withComp = Number.isFinite(value) && value === threshold && Number.isFinite(comp) && comp > compThreshold;
    const computed = extreme || withComp;
    const triggered = m.locked ? !!m.triggered : computed;

    let detail;
    if (!Number.isFinite(value)) {
      detail = m.memo || '未填写韭圈情绪指数。该指数为韭圈儿 App 自研数据，暂无公开接口，请手动录入。';
    } else if (extreme) {
      detail = `情绪指数 ${value} 低于极值线 ${threshold}，触发红线。`;
    } else if (withComp) {
      detail = `情绪指数等于 ${threshold}，但补偿 ${comp} 超过 ${compThreshold}，依旧默认触发。`;
    } else {
      detail = `情绪指数 ${value}，未进入极值区（需小于 ${threshold}）。`;
    }

    return makeItem(meta, {
      mode: 'manual',
      value: Number.isFinite(value) ? value : null,
      valueText: Number.isFinite(value) ? String(value) : '未录入',
      threshold, thresholdText: `< ${threshold}`, compare: 'lt',
      triggered, status: Number.isFinite(value) || m.locked ? (triggered ? STATUS.HIT : STATUS.SAFE) : STATUS.UNKNOWN,
      detail,
      rows: [
        { label: '极值线', value: `小于 ${threshold}` },
        { label: '补偿规则', value: `等于 ${threshold} 且补偿 > ${compThreshold} 也算触发` },
        { label: '数据来源', value: '韭圈儿 App（无公开接口，手动录入）' },
      ],
      source: '手动录入',
      observedAt: m.updatedAt ?? null,
    });
  };
}

/* ------------------------------ 11. PCR ------------------------------ */
function evalPcr(config) {
  return (raw) => {
    const meta = CATALOG[10];
    const low = config.thresholds.pcrLow;
    const need = config.thresholds.pcrNeed;
    const direction = config.params.pcr?.direction ?? 'below';
    const overrides = config.pcrValues ?? {};
    const metric = raw.pcrMetric ?? '成交量';

    const list = (raw.pcr ?? []).filter(Boolean);
    if (!list.length) {
      return makeItem(meta, {
        thresholdText: `4 个中 ${need} 个低于 ${low}`, compare: 'count',
        detail: '未能取到期权链（东财 clist 偶发限流，新浪备用源只覆盖股指期权）。',
        source: '东财 / 新浪 期权链',
      });
    }

    const isLow = (v) => (direction === 'below' ? v <= low : v >= low);
    const evaluated = list.map((x) => {
      const manualValue = toNumber(overrides[x.label]);
      const value = Number.isFinite(manualValue) ? manualValue : x.pcr;
      return { ...x, value, isManual: Number.isFinite(manualValue) && x.pcr !== manualValue };
    });

    const valid = evaluated.filter((x) => Number.isFinite(x.value));
    const lowList = valid.filter((x) => isLow(x.value));
    const triggered = lowList.length >= need;

    const rows = evaluated.map((x) => ({
      label: x.label,
      value: Number.isFinite(x.value)
        ? `${x.value.toFixed(3)}　${isLow(x.value) ? (direction === 'below' ? '低估 ✓' : '高估 ✓') : '—'}` +
          `　${x.isManual ? '手动' : x.source ?? ''}`
        : (x.note ?? '无数据'),
      tone: Number.isFinite(x.value) && isLow(x.value) ? 'warn' : undefined,
    }));
    rows.push({
      label: '判定口径',
      value: `${metric} PCR ｜ ${valid.length} 个品种有效，${lowList.length} 个${direction === 'below' ? '低于' : '高于'} ${low}（≥${need} 个触发）`,
    });
    rows.push({
      label: '说明',
      value: '原文只写「到达低估之下」，未给具体数值，阈值请在设置里按自己的口径校准。',
    });
    if (metric !== '成交量') {
      rows.push({ label: '提示', value: '当前用的是持仓量口径（东财链被限流时的备用源），与成交量口径阈值不可直接比较。', tone: 'warn' });
    }

    return makeItem(meta, {
      value: lowList.length,
      valueText: `${lowList.length} / ${valid.length} 个低估`,
      threshold: need, thresholdText: `4 个中 ${need} 个低于 ${low}`, compare: 'count',
      triggered, status: valid.length ? (triggered ? STATUS.HIT : STATUS.SAFE) : STATUS.UNKNOWN,
      detail: triggered
        ? `${lowList.map((x) => x.label).join('、')} 的 PCR 已进入低估区，达到 ${need} 个品种的触发条件。`
        : `当前 ${lowList.length} 个品种 PCR 进入低估区，还需 ${Math.max(0, need - lowList.length)} 个。`,
      rows,
      source: `期权链自算（${metric} PCR）`,
      observedAt: stamp(),
    });
  };
}

/* --------------------- 12. 6大科技点位（手动） --------------------- */
function evalTech(config) {
  return () => {
    const meta = CATALOG[11];
    const m = config.manual.tech ?? {};
    return makeItem(meta, {
      mode: 'manual',
      value: m.triggered ? 1 : 0,
      valueText: m.triggered ? '已到位' : '未到位',
      thresholdText: '主观判断（CPO / 半导体）', compare: 'manual',
      triggered: !!m.triggered, status: m.triggered ? STATUS.HIT : STATUS.SAFE,
      detail: m.memo || '6 大科技点位太分散，无法给出具体数据，重点看 CPO 和半导体。',
      rows: [
        { label: '重点方向', value: 'CPO、半导体' },
        { label: '维护方式', value: '手动切换' },
      ],
      source: '手动维护',
      observedAt: m.updatedAt ?? null,
    });
  };
}

const EVALUATORS = [
  evalVix1000, evalMargin, evalImBasis, evalBigBear, evalVolume, evalSizeRatio,
  evalRateHike, evalImPrice, evalKc50, evalSentiment, evalPcr, evalTech,
];

/* --------------------------- 总分与仓位建议 --------------------------- */
export function buildAdvice(count, total = 12) {
  const score = Math.round((count / total) * 100);
  if (count >= 11) {
    return {
      score, level: '重仓区', tone: 'extreme',
      action: '红线几乎全部触发，底部特征充分，可上较大仓位。',
      position: '总仓位可放到 70% 以上，分批买满。',
    };
  }
  if (count >= 9) {
    return {
      score, level: '动手区', tone: 'high',
      action: '达到作者本人的动手标准（本次计划 9 根红线动手）。',
      position: '可以正式动手，仓位可上到 50%~70%。',
    };
  }
  if (count >= 6) {
    return {
      score, level: '底仓区', tone: 'mid',
      action: '已满足「至少 6~8 条红线才动手」的原则下限。',
      position: '完全没仓位者可先买底仓（10%~30%）；已有多单仓位可再憋一下，等 10 根左右再动手。',
    };
  }
  if (count >= 3) {
    return {
      score, level: '观察区', tone: 'low',
      action: '红线不足 6 条，太早动手会在底部扛不住。',
      position: '保持耐心，只做观察和小额定投，不建议加仓。',
    };
  }
  return {
    score, level: '等待区', tone: 'calm',
    action: '红线还很少，说明机会还没到、还没到底部。',
    position: '空仓或极轻仓等待，必须保持耐心！',
  };
}

/** 执行全部指标判定 */
export function evaluateAll(config, raw) {
  const items = EVALUATORS.map((factory) => {
    try {
      return factory(config)(raw);
    } catch (err) {
      const index = EVALUATORS.indexOf(factory);
      return makeItem(CATALOG[index], {
        detail: `判定出错：${String(err?.message ?? err)}`,
        source: '计算异常',
      });
    }
  });

  const triggered = items.filter((i) => i.triggered === true).length;
  const unknown = items.filter((i) => i.triggered === null).length;
  const advice = buildAdvice(triggered, items.length);

  return {
    items,
    summary: {
      total: items.length,
      triggered,
      unknown,
      safe: items.length - triggered - unknown,
      ...advice,
    },
    observedAt: stamp(),
    dataErrors: raw?.errors ?? [],
  };
}
