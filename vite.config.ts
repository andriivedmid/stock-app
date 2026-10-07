import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const SA_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json,text/plain,*/*',
};

const RANGE_FETCH: Record<
  string,
  { range: string; period: string; trimDays?: number; keepLast?: number }
> = {
  '1D': { range: '3M', period: 'Daily', keepLast: 1 },
  '5D': { range: '3M', period: 'Daily', keepLast: 5 },
  '1M': { range: '3M', period: 'Daily', trimDays: 31 },
  '3M': { range: '3M', period: 'Daily' },
  '6M': { range: '6M', period: 'Daily' },
  '1Y': { range: '1Y', period: 'Daily' },
  '5Y': { range: '5Y', period: 'Daily' },
  MAX: { range: '10Y', period: 'Monthly' },
};

const ALLOWED_SEGMENTS = new Set(['s', 'e']);
const DAY = 86400;
const NY_TZ = 'America/New_York';

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type ExplainRequest = {
  seg: string;
  path: string;
  symbol: string;
  name: string;
  from: number;
  to: number;
};

type NewsItem = { title: string; date: string; source: string };

function sendJson(res: Connect.ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function sa(path: string): Promise<any> {
  const response = await fetch(`https://stockanalysis.com${path}`, { headers: SA_HEADERS });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.status === 400 || data?.status === 404) {
    throw new Error(data?.message || `Upstream responded with ${response.status}`);
  }
  return data;
}

async function twelveTimeSeries(
  symbol: string,
  interval: string,
  outputsize: number,
  apiKey: string,
  window?: { from: number; to: number },
): Promise<Candle[]> {
  let url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${interval}&outputsize=${outputsize}&timezone=UTC&order=asc&apikey=${apiKey}`;
  if (window) url += `&start_date=${isoDate(window.from)}&end_date=${isoDate(window.to)}`;
  const response = await fetch(url);
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.status !== 'ok') {
    throw new Error(
      data?.message || data?.error?.message || `Twelve Data responded with ${response.status}`,
    );
  }
  const values = Array.isArray(data?.values) ? data.values : [];
  const candles = values
    .map((v: any) => {
      const str = String(v.datetime).trim();
      const ms =
        str.length === 10
          ? exchangeDateToEpoch(str) * 1000
          : Date.parse(str.replace(' ', 'T') + 'Z');
      return {
        time: Math.floor(ms / 1000),
        open: Number(v.open),
        high: Number(v.high),
        low: Number(v.low),
        close: Number(v.close),
        volume: Number(v.volume || 0),
      };
    })
    .filter((c: Candle) => Number.isFinite(c.time) && Number.isFinite(c.close));
  if (candles.length === 0) throw new Error('No price data returned for that period');
  return candles;
}

function dedupeToDays(candles: Candle[], limit: number): Candle[] {
  const days = new Set<string>();
  const out: Candle[] = [];
  for (let i = candles.length - 1; i >= 0; i--) {
    const key = isoDate(candles[i].time);
    if (!days.has(key)) {
      days.add(key);
      if (days.size > limit) break;
    }
    out.unshift(candles[i]);
  }
  return out;
}

function keepRTH(candles: Candle[]): Candle[] {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    hour12: false,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  });
  return candles.filter((c) => {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(c.time * 1000)).map((p) => [p.type, p.value]));
    const mins = Number(parts.hour) * 60 + Number(parts.minute);
    return mins >= 9 * 60 + 30 && mins < 16 * 60;
  });
}

function wallTimeInNYToEpoch(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    hour12: false,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const nyOffsetMs = (ms: number): number => {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
    const wallUTC = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second),
    );
    return wallUTC - ms;
  };
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const offset = nyOffsetMs(guess);
  let ms = guess - offset;
  const offset2 = nyOffsetMs(ms);
  if (offset2 !== offset) ms = guess - offset2;
  return ms / 1000;
}

function exchangeDateToEpoch(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return wallTimeInNYToEpoch(y, m, d);
}

function parseHistory(payload: any): Candle[] {
  const rows = payload?.data;
  if (!Array.isArray(rows)) throw new Error('No price data for that symbol');
  const candles = rows
    .map((r: any) => ({
      time: Math.floor(exchangeDateToEpoch(String(r.t))),
      open: Number(r.o),
      high: Number(r.h),
      low: Number(r.l),
      close: Number(r.c),
      volume: Number(r.v ?? 0),
    }))
    .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close))
    .reverse();
  if (candles.length === 0) throw new Error('No price data for that symbol');
  return candles;
}

function pickHistoryRange(fromSeconds: number) {
  const days = (Date.now() / 1000 - fromSeconds) / DAY;
  if (days <= 85) return { range: '3M', period: 'Daily' };
  if (days <= 175) return { range: '6M', period: 'Daily' };
  if (days <= 345) return { range: '1Y', period: 'Daily' };
  if (days <= 1780) return { range: '5Y', period: 'Daily' };
  return { range: '10Y', period: 'Monthly' };
}

function isoDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

async function fetchNews(name: string, symbol: string, from: number, to: number): Promise<NewsItem[]> {
  const query = `${symbol} ${name} after:${isoDate(from)} before:${isoDate(to + DAY)}`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
    query,
  )}&hl=en-US&gl=US&ceid=US:en`;
  const response = await fetch(url, { headers: SA_HEADERS });
  if (!response.ok) throw new Error(`News feed responded with ${response.status}`);
  const xml = await response.text();

  const items: NewsItem[] = [];
  const seen = new Set<string>();
  for (const block of xml.match(/<item>[\s\S]*?<\/item>/g) ?? []) {
    const title = /<title>([\s\S]*?)<\/title>/.exec(block)?.[1]?.trim();
    const pubDate = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(block)?.[1]?.trim();
    const source = /<source[^>]*>([\s\S]*?)<\/source>/.exec(block)?.[1]?.trim();
    if (!title || seen.has(title)) continue;
    seen.add(title);
    const parsed = pubDate ? Math.floor(new Date(pubDate).getTime() / 1000) : null;
    items.push({
      title: title.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'),
      date: parsed ? isoDate(parsed) : '',
      source: source || '',
    });
    if (items.length >= 25) break;
  }
  return items;
}

type Stats = {
  startClose: number;
  endClose: number;
  pctChange: number;
  high: number;
  low: number;
  priorPct: number | null;
  maxGain: { date: string; pct: number } | null;
  maxDrop: { date: string; pct: number } | null;
  drawdownPct: number;
  avgVolume: number;
  topVolume: { date: string; volume: number } | null;
  relVolume: number | null;
  volumeSpikes: { date: string; volume: number; close: number }[];
};

function computeStats(window: Candle[], context: Candle[]): Stats {
  const first = window[0];
  const last = window[window.length - 1];
  let high = -Infinity;
  let low = Infinity;
  let maxGain: Stats['maxGain'] = null;
  let maxDrop: Stats['maxDrop'] = null;
  let peak = -Infinity;
  let drawdown = 0;
  let volSum = 0;
  let topVolume: Stats['topVolume'] = null;

  for (let i = 0; i < window.length; i++) {
    const c = window[i];
    high = Math.max(high, c.high);
    low = Math.min(low, c.low);
    volSum += c.volume;
    if (!topVolume || c.volume > topVolume.volume) {
      topVolume = { date: isoDate(c.time), volume: c.volume };
    }
    const prevClose = i > 0 ? window[i - 1].close : context.length ? context[context.length - 1].close : null;
    if (prevClose && prevClose > 0) {
      const pct = ((c.close - prevClose) / prevClose) * 100;
      if (!maxGain || pct > maxGain.pct) maxGain = { date: isoDate(c.time), pct };
      if (!maxDrop || pct < maxDrop.pct) maxDrop = { date: isoDate(c.time), pct };
    }
    peak = Math.max(peak, c.high);
    if (peak > 0) drawdown = Math.min(drawdown, ((c.low - peak) / peak) * 100);
  }

  const priorBars = context.slice(-10);
  const priorAvgVolume = priorBars.length
    ? priorBars.reduce((s, b) => s + b.volume, 0) / priorBars.length
    : null;
  const avgVolume = volSum / window.length;
  const spikes: Stats['volumeSpikes'] = [];
  if (priorAvgVolume && priorAvgVolume > 0) {
    for (const c of window) {
      if (c.volume > 2 * priorAvgVolume) {
        spikes.push({ date: isoDate(c.time), volume: c.volume, close: c.close });
      }
    }
  }
  spikes.sort((a, b) => b.volume - a.volume);

  const priorClose = context.length ? context[context.length - 1].close : null;
  return {
    startClose: first.close,
    endClose: last.close,
    pctChange: ((last.close - first.close) / first.close) * 100,
    high,
    low,
    priorPct: priorClose && priorClose > 0 ? ((first.close - priorClose) / priorClose) * 100 : null,
    maxGain,
    maxDrop,
    drawdownPct: drawdown,
    avgVolume: Math.round(avgVolume),
    topVolume,
    relVolume: priorAvgVolume && priorAvgVolume > 0 ? avgVolume / priorAvgVolume : null,
    volumeSpikes: spikes.slice(0, 4),
  };
}

function formatVolume(volume: number): string {
  if (volume >= 1e9) return (volume / 1e9).toFixed(2) + 'B';
  if (volume >= 1e6) return (volume / 1e6).toFixed(1) + 'M';
  if (volume >= 1e3) return (volume / 1e3).toFixed(0) + 'K';
  return String(volume);
}

function formatSeries(window: Candle[]): string {
  const withPct = window.map((c, i) => {
    const prevClose = i > 0 ? window[i - 1].close : null;
    const pct = prevClose ? ` (${(((c.close - prevClose) / prevClose) * 100).toFixed(2)}%)` : '';
    return `${isoDate(c.time)} ${c.close.toFixed(2)}${pct} vol ${formatVolume(c.volume)}`;
  });

  if (withPct.length <= 150) return withPct.join('\n');

  const step = Math.ceil(withPct.length / 150);
  return withPct.filter((_, i) => i % step === 0 || i === withPct.length - 1).join('\n');
}

function buildPrompt(
  req: ExplainRequest,
  stats: Stats,
  series: string,
  news: NewsItem[],
  period: string,
): string {
  const fmt = (n: number) => n.toFixed(2);
  const unit = period === 'Daily' ? 'day' : period === 'Weekly' ? 'week' : 'month';
  const volLines = [
    `- Volume: ${stats.avgVolume.toLocaleString('en-US')} per ${unit}`,
    stats.relVolume !== null && stats.relVolume !== undefined
      ? `- Volume is ${stats.relVolume.toFixed(2)}x the 10-${unit} average before the period`
      : null,
    stats.topVolume
      ? `- Highest volume ${unit}: ${stats.topVolume.date} (${formatVolume(stats.topVolume.volume)})`
      : null,
    stats.volumeSpikes.length
      ? `- Unusually high volume (${'>'}2x prior average): ${stats.volumeSpikes
          .map((s) => `${s.date} vol ${formatVolume(s.volume)} @ ${fmt(s.close)}`)
          .join(', ')}`
      : null,
  ];
  const lines = [
    `Symbol: ${req.symbol} (${req.name})`,
    `Highlighted period: ${isoDate(req.from)} to ${isoDate(req.to)} (${period} bars)`,
    '',
    'Price statistics for the period:',
    `- Close: ${fmt(stats.startClose)} → ${fmt(stats.endClose)} (${stats.pctChange >= 0 ? '+' : ''}${stats.pctChange.toFixed(2)}%)`,
    `- Range high/low: ${fmt(stats.high)} / ${fmt(stats.low)}`,
    stats.priorPct !== null ? `- Trend in the weeks just before: ${stats.priorPct.toFixed(2)}%` : null,
    stats.maxGain ? `- Biggest up ${unit}: ${stats.maxGain.date} (+${stats.maxGain.pct.toFixed(2)}%)` : null,
    stats.maxDrop ? `- Biggest down ${unit}: ${stats.maxDrop.date} (${stats.maxDrop.pct.toFixed(2)}%)` : null,
    `- Max drawdown from peak: ${stats.drawdownPct.toFixed(2)}%`,
    '',
    'Volume statistics for the period:',
    ...volLines,
    '',
    `Closing prices (${period} bars, % change vs previous bar, volume per bar):`,
    series,
    '',
    news.length
      ? `News headlines published during the period:\n${news
          .map((n) => `- ${n.date}${n.source ? ` (${n.source})` : ''}: ${n.title}`)
          .join('\n')}`
      : 'No news headlines were found for this period in the available feed.',
    '',
    'Focus on WHY the stock moved as it did: lead with the drivers and causes, and only briefly refer to the price action itself.',
  ];
  return lines.filter((l) => l !== null).join('\n');
}

const SYSTEM_PROMPT = `You are a markets analyst explaining a highlighted period of a stock chart to a retail investor.
Rules:
- Explain WHY more than WHAT: keep recital of raw price moves brief and secondary. Spend most of the answer on the CAUSES — the events, catalysts, and market backdrops that drove the move, tied to specific dates.
- When the cause is not visible in the headlines, say the data does not show a single cause and give the most plausible data-supported explanations (e.g. momentum, mean reversion, sector rotation).
- Use ONLY the price data and headlines provided. Never invent events, earnings dates, or figures.
- Attribute moves to headlines only when the timing clearly lines up.
- Consider volume where it is notable: volume far above the period or prior average confirms a move's conviction; mention it only when it stands out, tied to a specific date.
- Plain language, 140-240 words. Start with one sentence summarizing the move, then explain WHY it happened.
- No investment advice, no predictions, no price targets.
- Formatting: wrap key dates, figures, and phrases in **bold** (2-4 per paragraph) and wrap percentages like **+64%** the same way. No preamble, no header, no closing remarks — return the explanation body only.`;

async function callGroq(env: Record<string, string>, userPrompt: string): Promise<string> {
  const key = env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY is not set in .env');

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: env.GROQ_MODEL || 'openai/gpt-oss-120b',
      temperature: 0.3,
      max_tokens: 1800,
      reasoning_effort: 'low',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error?.message || `Groq responded with ${response.status}`);
  }
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Groq returned an empty response');
  return content.trim();
}

async function readBody(req: Connect.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function handleExplain(
  req: Connect.IncomingMessage,
  res: Connect.ServerResponse,
  env: Record<string, string>,
) {
  let body: ExplainRequest;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON body' });
  }

  const { seg, path, symbol, name, from, to } = body;
  if (!ALLOWED_SEGMENTS.has(String(seg))) return sendJson(res, 400, { error: 'Invalid symbol type' });
  if (!path || !/^[A-Za-z0-9._\-/]+$/.test(path) || path.includes('..')) {
    return sendJson(res, 400, { error: 'Invalid symbol' });
  }
  if (
    typeof from !== 'number' ||
    typeof to !== 'number' ||
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from >= to ||
    to - from > 20 * 365 * DAY
  ) {
    return sendJson(res, 400, { error: 'Invalid date range' });
  }

  try {
    const { range, period } = pickHistoryRange(from - 45 * DAY);
    const tooOld = from - 45 * DAY < Date.now() / 1000 - 10 * 365 * DAY;
    let candles: Candle[];
    if (period === 'Monthly' && tooOld) {
      if (!env.TWELVE_DATA_API_KEY) {
        return sendJson(res, 400, {
          error: 'This period predates the available data history on this provider',
        });
      }
      candles = await twelveTimeSeries(String(path), '1month', 1000, env.TWELVE_DATA_API_KEY);
    } else {
      const history = await sa(
        `/api/symbol/${seg}/${path}/history?range=${range}&period=${period}`,
      );
      candles = parseHistory(history);
    }

    const pad = period === 'Daily' ? 0 : period === 'Weekly' ? 7 * DAY : 31 * DAY;
    let window = candles.filter((c) => c.time >= from - pad && c.time <= to + pad);
    const context = candles.filter((c) => c.time < from - pad).slice(-10);

    if (window.length < 2) {
      const widened = candles.filter((c) => c.time >= from - 14 * DAY && c.time <= to + DAY);
      if (widened.length >= 2) window = widened;
    }

    if (window.length < 2) {
      return sendJson(res, 400, { error: 'Not enough price data in that period' });
    }

    const stats = computeStats(window, context);
    const series = formatSeries(window);
    const news = await fetchNews(name, symbol, from, to).catch(() => [] as NewsItem[]);
    const prompt = buildPrompt({ seg, path, symbol, name, from, to }, stats, series, news, period);
    const analysis = await callGroq(env, prompt);

    sendJson(res, 200, {
      analysis,
      stats,
      news,
      model: env.GROQ_MODEL || 'openai/gpt-oss-120b',
    });
  } catch (err) {
    sendJson(res, 502, { error: err instanceof Error ? err.message : 'Request failed' });
  }
}

function stockApiPlugin(env: Record<string, string>): Plugin {
  return {
    name: 'stock-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();
        if (req.url.startsWith('/api/explain') && req.method === 'POST') {
          void handleExplain(req, res, env);
          return;
        }
        void handleReadOnly(req, res, env);
      });
    },
  };
}

function sendChartResponse(
  res: Connect.ServerResponse,
  q: any,
  candles: Candle[],
  fallbackSymbol: string,
) {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  sendJson(res, 200, {
    symbol: q?.symbol || fallbackSymbol,
    exchange: q?.ex || '',
    marketState: q?.ms || '',
    price: typeof q?.p === 'number' ? q.p : last.close,
    change: typeof q?.c === 'number' ? q.c : prev ? last.close - prev.close : 0,
    changePct: typeof q?.cp === 'number' ? q.cp : 0,
    previousClose: typeof q?.cl === 'number' ? q.cl : prev?.close ?? last.close,
    candles,
  });
}

async function handleReadOnly(
  req: Connect.IncomingMessage,
  res: Connect.ServerResponse,
  env: Record<string, string>,
) {
  const url = new URL(req.url || '/', 'http://localhost');
  try {
    if (url.pathname === '/api/search') {
      const query = (url.searchParams.get('q') || '').trim();
      if (!query) return sendJson(res, 200, { quotes: [] });
      const data = await sa(`/api/search?q=${encodeURIComponent(query)}`);
      const quotes = (Array.isArray(data?.data) ? data.data : [])
        .filter((r: any) => r.s && r.t && ALLOWED_SEGMENTS.has(r.t))
        .slice(0, 10)
        .map((r: any) => ({
          symbol: r.id,
          name: r.n || r.id,
          path: r.s,
          seg: r.t,
          type: r.t === 'e' ? 'ETF' : 'Stock',
        }));
      return sendJson(res, 200, { quotes });
    }

    if (url.pathname === '/api/chart') {
      const seg = url.searchParams.get('seg') || '';
      const path = url.searchParams.get('path') || '';

      if (!ALLOWED_SEGMENTS.has(seg)) return sendJson(res, 400, { error: 'Invalid symbol type' });
      if (!path || !/^[A-Za-z0-9._\-/]+$/.test(path) || path.includes('..')) {
        return sendJson(res, 400, { error: 'Invalid symbol' });
      }

      const interval = url.searchParams.get('interval');
      if (interval === '15min' || interval === 'daily') {
        const from = Number(url.searchParams.get('from'));
        const to = Number(url.searchParams.get('to'));
        if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
          return sendJson(res, 400, { error: 'Invalid date range' });
        }
        if (!env.TWELVE_DATA_API_KEY) {
          return sendJson(res, 400, { error: 'Higher-resolution data is unavailable (no API key)' });
        }
        const spanDays = (to - from) / DAY;
        let candles: Candle[];
        if (interval === '15min') {
          if (spanDays > 6.5) {
            return sendJson(res, 400, { error: 'Window too large for 15-minute data' });
          }
          if (to < Date.now() / 1000 - 730 * DAY) {
            return sendJson(res, 400, { error: '15-minute data is only available for recent periods' });
          }
          const bars = await twelveTimeSeries(
            path,
            '15min',
            Math.min(5000, Math.ceil(spanDays * 60) + 60),
            env.TWELVE_DATA_API_KEY,
            { from, to },
          );
          candles = keepRTH(bars);
        } else {
          if (spanDays > 5000) {
            return sendJson(res, 400, { error: 'Window too large for daily data' });
          }
          candles = await twelveTimeSeries(
            path,
            '1day',
            Math.min(5000, Math.ceil(spanDays) + 10),
            env.TWELVE_DATA_API_KEY,
            { from, to },
          );
        }
        if (candles.length === 0) {
          return sendJson(res, 404, { error: 'No price data for that period' });
        }
        const quote = await sa(`/api/quotes/${seg}/${path}`).catch(() => null);
        return sendChartResponse(res, quote?.data ?? null, candles, path.split('/').pop());
      }

      const range = (url.searchParams.get('range') || '1Y').toUpperCase();
      const fetchSpec = RANGE_FETCH[range];
      if (!fetchSpec) return sendJson(res, 400, { error: 'Invalid range' });

      let candles: Candle[] | null = null;
      if (env.TWELVE_DATA_API_KEY && (range === '1D' || range === '5D' || range === 'MAX')) {
        try {
          candles =
            range === '1D'
              ? dedupeToDays(
                  keepRTH(await twelveTimeSeries(path, '5min', 300, env.TWELVE_DATA_API_KEY)),
                  1,
                )
              : range === '5D'
                ? dedupeToDays(
                    keepRTH(await twelveTimeSeries(path, '15min', 500, env.TWELVE_DATA_API_KEY)),
                    5,
                  )
                : await twelveTimeSeries(path, '1month', 1000, env.TWELVE_DATA_API_KEY);
        } catch {
          candles = null;
        }
      }

      const [history, quote] = await Promise.allSettled([
        sa(`/api/symbol/${seg}/${path}/history?range=${fetchSpec.range}&period=${fetchSpec.period}`),
        sa(`/api/quotes/${seg}/${path}`),
      ]);

      if (candles === null) {
        if (history.status === 'rejected') throw history.reason;
        candles = parseHistory(history.value);
        if (fetchSpec.trimDays) {
          const cutoff = Date.now() / 1000 - fetchSpec.trimDays * DAY;
          candles = candles.filter((c) => c.time >= cutoff);
        }
        if (fetchSpec.keepLast) {
          candles = candles.slice(-fetchSpec.keepLast);
        }
      }

      const q = quote.status === 'fulfilled' ? quote.value?.data : null;
      return sendChartResponse(res, q, candles, path.split('/').pop());
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(res, 502, { error: err instanceof Error ? err.message : 'Request failed' });
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), stockApiPlugin(env)],
    server: { port: 5173 },
  };
});
