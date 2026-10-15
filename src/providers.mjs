/**
 * 数据源适配层
 *
 * 全部使用公开接口，无需 API Key：
 *  - 东方财富 push2 / push2his  ：指数、期货实时行情与日K线
 *  - 东方财富 datacenter         ：融资融券余额历史
 *  - 东方财富 push2 clist        ：期权链（自算成交量 PCR）
 *  - 新浪财经                    ：中金所股指期权链（自算隐波与持仓量 PCR 备用源）
 *  - 期权论坛 optbbs QVIX 导出表  ：各品种期权隐含波动率指数（1000 股指序列已停更，仅作对照）
 */
import { fetchJson, fetchText, mean, tail, toNumber } from './util.mjs';
import { impliedVolFromChains, expiryOf } from './volatility.mjs';

/** 用到的标的（东财 secid：市场码.代码） */
export const SECID = {
  csi1000: '1.000852',   // 中证1000
  csi300: '1.000300',    // 沪深300
  csi500: '1.000905',    // 中证500
  star50: '1.000688',    // 科创50
  sse50: '1.000016',     // 上证50
  csi2000: '2.932000',   // 中证2000
  cnBig: '0.399314',     // 巨潮大盘
  cnSmall: '0.399316',   // 巨潮小盘
  imMain: '8.150130',    // IM 主力合约（中证1000股指期货）
  imFront: '8.150120',   // IM 当月连续
  imNext: '8.150121',    // IM 下月连续
};

const cache = new Map();
/** 简易 TTL 缓存，避免对同一接口高频请求 */
export async function cached(key, ttlMs, producer) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) {
    if (hit.error) throw hit.error;
    return hit.value;
  }
  try {
    const value = await producer();
    cache.set(key, { at: now, value });
    return value;
  } catch (error) {
    // 失败时保留 30 秒的负缓存，避免连环重试
    cache.set(key, { at: now - ttlMs + 30000, error });
    throw error;
  }
}
export const clearCache = () => cache.clear();

/** 批量实时行情 */
export async function getQuotes(secids) {
  const list = Array.isArray(secids) ? secids : Object.values(secids);
  const url =
    'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2' +
    `&secids=${list.join(',')}&fields=f1,f2,f3,f4,f12,f13,f14,f124`;
  const json = await fetchJson(url);
  const rows = json?.data?.diff ?? [];
  const out = {};
  for (const row of rows) {
    const key = `${row.f13}.${row.f12}`;
    out[key] = {
      secid: key,
      code: String(row.f12),
      name: row.f14,
      price: toNumber(row.f2),
      pct: toNumber(row.f3),
      change: toNumber(row.f4),
      quoteTime: row.f124 ? new Date(row.f124 * 1000) : null,
    };
  }
  return out;
}

/** 日K线（前复权） */
export async function getKline(secid, limit = 260) {
  const url =
    'https://push2his.eastmoney.com/api/qt/stock/kline/get?fields1=f1,f2,f3,f4,f5,f6' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61' +
    `&klt=101&fqt=1&end=20500101&lmt=${limit}&secid=${secid}`;
  const json = await fetchJson(url);
  const klines = json?.data?.klines ?? [];
  return klines.map((line) => {
    const [date, open, close, high, low, volume, amount, amplitude, pct, change, turnover] = line.split(',');
    return {
      date,
      open: toNumber(open),
      close: toNumber(close),
      high: toNumber(high),
      low: toNumber(low),
      volume: toNumber(volume),
      amount: toNumber(amount),
      amplitude: toNumber(amplitude),
      pct: toNumber(pct),
      change: toNumber(change),
      turnover: toNumber(turnover),
    };
  });
}

/** 带 TTL 缓存的日K线 */
export const getKlineCached = (secid, limit = 260) =>
  cached(`kline:${secid}:${limit}`, 5 * 60 * 1000, () => getKline(secid, limit));

/** 融资融券历史（融资余额单位：元） */
export async function getMarginHistory(pageSize = 40) {
  const url =
    'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_RZRQ_LSHJ' +
    `&columns=ALL&sortColumns=DIM_DATE&sortTypes=-1&pageSize=${pageSize}&pageNumber=1&source=WEB&client=WEB`;
  const json = await fetchJson(url);
  return (json?.result?.data ?? []).map((d) => ({
    date: String(d.DIM_DATE ?? '').slice(0, 10),
    financing: toNumber(d.RZYE),        // 融资余额
    financingBuy: toNumber(d.RZMRE),    // 融资买入额
    financingNet: toNumber(d.RZJME),    // 融资净买入
    securities: toNumber(d.RQYE),       // 融券余额
    total: toNumber(d.RZRQYE),          // 融资融券余额
    marketCap: toNumber(d.LTSZ),        // 两市流通市值
  }));
}

/* ------------------------------------------------------------------ *
 * QVIX（期权论坛导出的多品种隐含波动率指数）
 * 列位置由 AKShare index_option_qvix.py 的取列方式确认。
 * 注意：该表上游自 2026 年 6 月起公式损坏，
 *       中证1000 / 中证300 / 上证50 股指三个序列已无有效值；
 *       第 67~78 列存在两个品种两两交错的数据污染，故不作解析。
 *       因此「中证1000 VIX」改为用中金所 MO 期权链自算（见 volatility.mjs）。
 * ------------------------------------------------------------------ */
const QVIX_URL = 'https://1.optbbs.com/d/csv/d/k.csv';
export const QVIX_LAYOUT = {
  '50ETF': [1, 2, 3, 4],
  '300ETF': [9, 10, 11, 12],
  '中证1000股指（已停更）': [25, 26, 27, 28],
  '深证100ETF': [75, 76, 77, 78],
  '科创板50': [83, 84, 85, 86],
};

/** 抓取 QVIX 表，返回各品种最近若干日的收盘序列 */
export async function getQvix(limit = 90) {
  const text = await fetchText(QVIX_URL, { referer: 'https://www.optbbs.com/', timeout: 20000 });
  const rows = text
    .trim()
    .split('\n')
    .filter((line) => /^\d{4}\/\d{1,2}\/\d{1,2},/.test(line))
    .map((line) => line.split(','));

  const recent = rows.slice(-limit);
  const series = {};
  for (const [name, [oi, hi, li, ci]] of Object.entries(QVIX_LAYOUT)) {
    series[name] = recent
      .map((cells) => ({
        date: cells[0].trim().replace(/\//g, '-'),
        open: toNumber(cells[oi]),
        high: toNumber(cells[hi]),
        low: toNumber(cells[li]),
        close: toNumber(cells[ci]),
      }))
      .filter((p) => p.close !== null && p.close > 0);
  }
  return { latestDate: recent.length ? recent[recent.length - 1][0].trim().replace(/\//g, '-') : null, series, rowCount: rows.length };
}

/* ------------------------------------------------------------------ *
 * 新浪财经：中金所股指期权链（io / mo / ho）
 * 返回结构 data.up = 认购，data.down = 认沽
 * 每行：[买量, 买价, 最新价, 卖价, 卖量, 持仓量, 涨跌, 行权价, 标识]
 * ------------------------------------------------------------------ */
const SINA_OPTION_URL = 'https://stock.finance.sina.com.cn/futures/api/openapi.php/OptionService.getOptionData';

export async function getSinaChain(product, month) {
  const url = `${SINA_OPTION_URL}?type=futures&product=${product}&exchange=cffex&pinzhong=${product.toUpperCase()}${month}`;
  const json = JSON.parse(
    await fetchText(url, { referer: 'https://stock.finance.sina.com.cn/', timeout: 12000 }),
  );
  const data = json?.result?.data;
  if (!data?.up?.length || !data?.down?.length) return null;

  // 注意：新浪返回的认沽行有时会省略「行权价」列，因此行权价优先从合约代码解析
  const parse = (rows) =>
    rows
      .map((r) => {
        const code = String(r[r.length - 1] ?? '');
        const fromCode = /(\d{3,5})$/.exec(code);
        const strike = toNumber(r[7]) ?? (fromCode ? Number(fromCode[1]) : null);
        return {
          strike,
          last: toNumber(r[2]),
          openInterest: toNumber(r[5]) ?? 0,
          code,
        };
      })
      .filter((o) => Number.isFinite(o.strike) && o.strike > 0);
  return { calls: parse(data.up), puts: parse(data.down) };
}

/** 由当前月份推出生效的候选月份（YYMM） */
export function candidateMonths(now = new Date(), count = 5) {
  const list = [];
  for (let i = 0; i < count; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    list.push(`${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return list;
}

/** 抓取某品种所有有效月份的期权链，全部失败时抛出最后一次的错误 */
export async function getSinaChains(product, months = candidateMonths()) {
  const out = [];
  let lastError = null;
  for (const month of months) {
    try {
      const chain = await getSinaChain(product, month);
      if (chain) out.push({ month, chain });
    } catch (err) {
      lastError = err;
    }
  }
  if (!out.length && lastError) throw lastError;
  return out;
}

/* ------------------------------------------------------------------ *
 * 东方财富期权链（clist 接口，偶发限流，作为 PCR 的主源）
 * 市场码：10 = 上交所 ETF 期权，12 = 深交所 ETF 期权，221 = 中金所股指期权
 * push2 被限流时自动切到 push2test，两者数据一致
 * ------------------------------------------------------------------ */
const EM_QUOTE_HOSTS = ['push2.eastmoney.com', 'push2test.eastmoney.com'];

export async function getOptionChain(market, { pageSize = 100, maxPages = 12 } = {}) {
  let lastError = null;
  for (const host of EM_QUOTE_HOSTS) {
    try {
      const all = [];
      for (let pn = 1; pn <= maxPages; pn += 1) {
        const url =
          `https://${host}/api/qt/clist/get?po=1&np=1&fltt=2&invt=2&fid=f12` +
          `&pn=${pn}&pz=${pageSize}&fs=m:${market}&fields=f12,f13,f14,f2,f3,f5,f6,f108`;
        const json = await fetchJson(url, { referer: 'https://quote.eastmoney.com/' });
        const diff = json?.data?.diff;
        if (!diff) break;
        const rows = Object.values(diff);
        if (!rows.length) break;
        all.push(...rows);
        if (all.length >= (json?.data?.total ?? 0)) break;
      }
      return all.map((r) => ({
        code: String(r.f12),
        name: String(r.f14 ?? ''),
        price: toNumber(r.f2),
        pct: toNumber(r.f3),
        volume: toNumber(r.f5) ?? 0,
        amount: toNumber(r.f6),
        openInterest: toNumber(r.f108) ?? 0,
      }));
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('期权链请求失败');
}

const classifyEtfOption = (name) => {
  const side = name.includes('沽') ? 'put' : name.includes('购') ? 'call' : null;
  if (!side) return null;
  return { underlying: name.split(/[沽购]/)[0].trim(), side };
};
const classifyCffexOption = (code) => {
  const m = /^([A-Z]+)\d{4}-([CP])-/.exec(code);
  if (!m) return null;
  return { underlying: m[1], side: m[2] === 'P' ? 'put' : 'call' };
};

/**
 * 由东财期权链（上交所 m:10 + 中金所 m:221）汇总四个品种的成交量 PCR
 * 科创50 在上交所同时有「科创50」与「科创板50」两个期权品种（华夏/易方达），合并计算。
 */
export function pcrFromEastmoney({ cffex, etf }) {
  const build = (label, rows, classifier, match, source) => {
    const calls = [];
    const puts = [];
    for (const r of rows) {
      const info = classifier(r.code) ?? classifier(r.name);
      if (!info || info.underlying !== match) continue;
      (info.side === 'call' ? calls : puts).push(r);
    }
    if (!calls.length || !puts.length) {
      return { label, ok: false, source, note: `未匹配到「${match}」期权合约` };
    }
    const sum = (arr, f) => arr.reduce((s, x) => s + (x[f] ?? 0), 0);
    const cv = sum(calls, 'volume');
    const pv = sum(puts, 'volume');
    const co = sum(calls, 'openInterest');
    const po = sum(puts, 'openInterest');
    return {
      label, ok: true, source, metric: '成交量',
      pcr: cv ? Math.round((pv / cv) * 1000) / 1000 : null,
      oiPcr: co ? Math.round((po / co) * 1000) / 1000 : null,
      putVolume: pv, callVolume: cv,
      contracts: calls.length + puts.length,
    };
  };

  const kcb = build('科创50', etf, classifyEtfOption, '科创50', '东财·上交所 科创50ETF 期权');
  // 上交所另有一个「科创板50」品种（易方达 588080），量并入科创50
  const kcb2 = build('科创板50', etf, classifyEtfOption, '科创板50', '东财·上交所 科创板50ETF 期权');
  if (kcb.ok && kcb2.ok && kcb2.callVolume > 0) {
    const cv = kcb.callVolume + kcb2.callVolume;
    const pv = kcb.putVolume + kcb2.putVolume;
    kcb.pcr = cv ? Math.round((pv / cv) * 1000) / 1000 : kcb.pcr;
    kcb.putVolume = pv;
    kcb.callVolume = cv;
    kcb.contracts += kcb2.contracts;
    kcb.source = '东财·上交所 科创50 + 科创板50ETF 期权';
  }

  return [
    build('沪深300', cffex, classifyCffexOption, 'IO', '东财·中金所 IO 沪深300股指期权'),
    build('中证1000', cffex, classifyCffexOption, 'MO', '东财·中金所 MO 中证1000股指期权'),
    build('中证500', etf, classifyEtfOption, '500ETF', '东财·上交所 500ETF 期权'),
    kcb,
  ];
}

/** 由新浪中金所期权链汇总持仓量 PCR（东财链不可用时的备用源） */
export function pcrFromSina(chainMap) {
  const spec = [
    ['沪深300', 'io', '东财/新浪·中金所 IO'],
    ['中证1000', 'mo', '东财/新浪·中金所 MO'],
  ];
  return spec.map(([label, product, source]) => {
    const chains = chainMap[product] ?? [];
    if (!chains.length) return { label, ok: false, source, note: '未取到期权链' };
    let pv = 0;
    let cv = 0;
    let contracts = 0;
    for (const { chain } of chains) {
      pv += chain.puts.reduce((s, x) => s + (x.openInterest ?? 0), 0);
      cv += chain.calls.reduce((s, x) => s + (x.openInterest ?? 0), 0);
      contracts += chain.calls.length + chain.puts.length;
    }
    return {
      label, ok: cv > 0, source, metric: '持仓量',
      pcr: cv ? Math.round((pv / cv) * 1000) / 1000 : null,
      openInterestOnly: true,
      putVolume: pv, callVolume: cv, contracts,
    };
  });
}

/* ------------------------------------------------------------------ *
 * 原始数据聚合
 * ------------------------------------------------------------------ */
/** 每次刷新都调用的高频数据 */
export async function collectQuoteData(config) {
  const errors = [];
  const guard = async (name, fn, fallback) => {
    try {
      return await fn();
    } catch (err) {
      errors.push({ source: name, message: String(err?.cause?.message ?? err?.message ?? err) });
      return fallback;
    }
  };

  const sizePair = config?.params?.sizeRatio ?? {};
  const secidList = [...new Set(Object.values(SECID))];
  const months = candidateMonths();
  const sinaChains = () => cached('sinaCffex', 5 * 60 * 1000, async () => ({
    io: await getSinaChains('io', months),
    mo: await getSinaChains('mo', months),
  }));

  const [quotes, margin, qvix, chains, cffexChain, etfChain, kline1000, klineBig, klineSmall] =
    await Promise.all([
      guard('实时行情', () => getQuotes(secidList), {}),
      guard('融资融券余额', () => getMarginHistory(40), []),
      guard('QVIX 波动率', () => cached('qvix', 30 * 60 * 1000, () => getQvix(90)), null),
      guard('中金所期权链(新浪)', sinaChains, { io: [], mo: [] }),
      guard('中金所期权链(东财)', () => cached('em221', 10 * 60 * 1000, () => getOptionChain(221)), []),
      guard('ETF期权链(东财)', () => cached('em10', 10 * 60 * 1000, () => getOptionChain(10)), []),
      guard('中证1000 日K', () => getKlineCached(SECID.csi1000, 300), []),
      guard('大盘指数 日K', () => getKlineCached(sizePair.numerator ?? SECID.cnBig, 1400), []),
      guard('小盘指数 日K', () => getKlineCached(sizePair.denominator ?? SECID.cnSmall, 1400), []),
    ]);

  // 中证1000 隐波：优先 MO，退到 IO
  const impliedVol = (() => {
    for (const [product, source] of [['mo', '中金所 MO 期权链（新浪）'], ['io', '中金所 IO 期权链（新浪）']]) {
      const list = chains?.[product] ?? [];
      if (!list.length) continue;
      const r = impliedVolFromChains(list);
      if (r) return { ...r, product: product.toUpperCase(), source };
    }
    return null;
  })();

  // PCR：优先东财（成交量口径，四品种齐全），否则退到新浪（持仓量口径，两个品种）
  const useEastmoney = cffexChain.length > 0 || etfChain.length > 0;
  const pcr = useEastmoney
    ? pcrFromEastmoney({ cffex: cffexChain, etf: etfChain })
    : pcrFromSina(chains ?? {});

  return {
    fetchedAt: new Date(),
    quotes,
    margin,
    qvix,
    impliedVol,
    pcr,
    pcrMetric: useEastmoney ? '成交量' : '持仓量',
    kline: { csi1000: kline1000, big: klineBig, small: klineSmall },
    counts: {
      cffexChain: cffexChain.length,
      etfChain: etfChain.length,
      sinaIoMonths: chains?.io?.length ?? 0,
      sinaMoMonths: chains?.mo?.length ?? 0,
      marginRows: margin.length,
      qvixRows: qvix?.rowCount ?? 0,
    },
    errors,
  };
}

/** 兼容旧调用名 */
export const collectRaw = collectQuoteData;

export { expiryOf, mean, tail };
