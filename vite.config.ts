import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const SA_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json,text/plain,*/*',
};

const RANGE_FETCH: Record<
  string,
  { range: string; period: string; trimDays?: number; keepLast?: number; days?: number }
> = {
  '1D': { range: '3M', period: 'Daily', keepLast: 1, days: 1 },
  '5D': { range: '3M', period: 'Daily', keepLast: 5, days: 5 },
  '1M': { range: '3M', period: 'Daily', trimDays: 31, days: 31 },
  '3M': { range: '3M', period: 'Daily', days: 92 },
  '6M': { range: '6M', period: 'Daily', days: 183 },
  '1Y': { range: '1Y', period: 'Daily', days: 366 },
  '5Y': { range: '5Y', period: 'Daily', days: 1827 },
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
  question?: string;
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
  const start = from - 2 * DAY;
  const end = to + 2 * DAY;
  const queries = [
    `${symbol} ${name}`,
    `${name}`,
    `${symbol}`,
  ];
  const seen = new Set<string>();
  const items: NewsItem[] = [];

  // Patterns for low-quality aggregator/listicle headlines
  const junkPatterns = [
    /in today'?s? top stories related to/i,
    /top \d+ stories/i,
    /related to .*\([A-Z]{1,5}\)/i,
    /^the \w+ times?in/i,
    /^\w+ in today'?s?/i,
    /^\w+\s+\([A-Z]{1,5}\)$/,
    /^top headlines/i,
    /daily (brief|summary|roundup)/i,
    /^\w+\s*[-–—]\s*\w+$/, // "Title - Source" with no real content
    /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+[A-Z][a-z]+.*[-–—]\s*[A-Z][a-z]+/, // "Source Title - Source" duplication
  ];

  // Known financial news sources - headlines ending with these are often just platform links
  const knownSources = [
    'Yahoo Finance', 'Bloomberg', 'Reuters', 'CNBC', 'MarketWatch',
    'Seeking Alpha', 'Investopedia', 'Business Insider', 'Fox Business',
    "Barron's", 'The Wall Street Journal', 'The New York Times',
    'Financial Times', 'CNN Business', 'Fortune', 'Forbes',
    'Morningstar', 'Zacks', 'TipRanks', 'Benzinga', 'The Motley Fool',
    'The Street', 'Real Money', 'ValueWalk', '24/7 Wall St'
  ];

  function isJunk(title: string): boolean {
    const t = title.trim();
    if (t.length < 20) return true; // too short
    if (!/[a-z]/.test(t)) return true; // no lowercase = likely all caps junk

    // Check for "Title - Source" where source is a known financial platform
    const dashParts = t.split(/[-–—]/).map(s => s.trim());
    if (dashParts.length >= 2) {
      const lastPart = dashParts[dashParts.length - 1];
      // If last part is a known source, it's likely just a platform link
      for (const src of knownSources) {
        if (new RegExp(`^${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i').test(lastPart)) {
          // Also check if the first part mentions the same source (duplication)
          const firstPart = dashParts[0];
          if (new RegExp(src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(firstPart)) {
            return true; // "Source ... - Source" duplication
          }
          // Or if first part is very short/generic
          if (firstPart.length < 30) return true; // "Apple - Yahoo Finance"
          return true; // "Some Title - Yahoo Finance" = likely just a link
        }
      }
    }

    // Check for source duplication in title (e.g., "Yahoo Finance... - Yahoo Finance")
    for (const src of knownSources) {
      const escaped = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`^${escaped}[\\s\\S]*[-–—]\\s*${escaped}$`, 'i').test(t)) {
        return true; // "Source ... - Source" duplication
      }
    }

    for (const re of junkPatterns) {
      if (re.test(t)) return true;
    }
    return false;
  }

  for (const query of queries) {
    const q = `${query} after:${isoDate(start)} before:${isoDate(end + DAY)}`;
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
    const response = await fetch(url, { headers: SA_HEADERS });
    if (!response.ok) continue;
    const xml = await response.text();
    for (const block of xml.match(/<item>[\s\S]*?<\/item>/g) ?? []) {
      const title = /<title>([\s\S]*?)<\/title>/.exec(block)?.[1]?.trim();
      const pubDate = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(block)?.[1]?.trim();
      const source = /<source[^>]*>([\s\S]*?)<\/source>/.exec(block)?.[1]?.trim();
      if (!title || seen.has(title) || isJunk(title)) continue;
      seen.add(title);
      const parsed = pubDate ? Math.floor(new Date(pubDate).getTime() / 1000) : null;
      items.push({
        title: title.replace(/&/g, '&').replace(/'/g, "'").replace(/"/g, '"'),
        date: parsed ? isoDate(parsed) : '',
        source: source || '',
      });
      if (items.length >= 30) break;
    }
    if (items.length >= 30) break;
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
  const question = req.question?.trim();
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
    question ? `\nUser question: ${question}` : '',
    '',
    'Focus on WHY the stock moved as it did: lead with the drivers and causes, and only briefly refer to the price action itself.',
  ];
  return lines.filter((l) => l !== null).join('\n');
}

const SYSTEM_PROMPT = `You are a markets analyst explaining a highlighted period of a stock chart to a retail investor.

OUTPUT STRUCTURE:
1. Headline title — one markdown H1 line that names the stock, the direction of the move, and the main driver, in plain English. Example: "# Apple stock falls on pandemic worries". Exactly one line, no trailing period.
2. Company snapshot — a short paragraph (3-4 sentences) summarizing the company: what it does and its rough global size/scale (e.g., "one of the world's largest companies", "multi-billion dollar revenue"). Describe scale qualitatively — DO NOT invent specific revenue, net-income, profit-margin, market-cap, or other figures. Only cite a specific number if you are highly confident it is a correct, widely known public figure. Never say the figures are unavailable or not in the data set. End with a one-sentence "vibe" assessment (e.g., "A high-margin, cash-generating machine facing slowing iPhone growth").
3. Body made mostly of bullet points (3-6), one bullet per distinct driver or move phase. Use short paragraphs only where a bullet does not fit.

RULES:
- Explain WHY more than WHAT: keep recital of raw price moves brief and secondary. Spend most of the answer on the CAUSES — the events, catalysts, and market backdrops that drove the move, tied to specific dates.
- If the period contains MULTIPLE moves, especially in different directions (up AND down at different times), cover EACH move in its OWN bullet point or paragraph, with its own dates, its own approximate size, and its own cause.
- Break the drivers into separate bullet points rather than merging them — the more distinct the reason, the more distinct the bullet.
- When the cause is not visible in the headlines, say the data does not show a single cause and give the most plausible data-supported explanations (e.g. momentum, mean reversion, sector rotation).
- Use ONLY the price data and headlines provided. Never invent events, earnings dates, or figures. (This data restriction applies to the price-move analysis. The company snapshot may use your own general knowledge — it is joined as "you are a markets analyst" anyway.)
- Attribute moves to headlines only when the timing clearly lines up.
- Consider volume where it is notable: volume far above the period or prior average confirms a move's conviction; mention it only when it stands out, tied to a specific date.

MACRO EVENT EXCEPTION (narrow, verifiable only):
- You MAY reference a major, widely documented public event (e.g., US presidential election, FOMC rate decision, pandemic lockdown, war outbreak) WITHOUT a provided headline ONLY IF:
  a) The event has a single, universally known calendar date.
  b) The price move in the data lines up with that date (within ~5 trading days).
  c) The event's link to the move is established in mainstream financial reporting (not speculation).
- If used, state it plainly: "The Nov 5 US election..." or "The March 2020 lockdown..." — no hedging, no invented details. Still never invent the event itself or its date.

PERCENTAGE FORMAT — CRITICAL:
- Always write percentages with an explicit sign: +3.2% for gains, -2.7% for drops.
- Never write bare percentages without a sign, and never write "down 20%" — write -20% instead.
  Correct: "first gained +12% in April, then dropped -18% in June."
- The system will automatically bold all percentages; do not add **bold** around them.

USER QUESTION:
- If a user question is provided at the end of the prompt, address it directly in a short final paragraph after the bullet points. Keep it concise (2-3 sentences).

- No investment advice, no predictions, no price targets.
- Whole answer roughly 200-300 words. No preamble, no code fences, no closing remarks — output the headline, company snapshot, and body only.`;

const GROQ_MODEL_CHAIN = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3.8-27b',
  'allam-2-7b',
];

const groqCooldowns = new Map<string, number>();

function groqCooldown(status: number, message: string): number {
  if (/per day|daily|24 ?hour/i.test(message)) {
    const next = new Date();
    next.setUTCHours(24, 0, 0, 0);
    return next.getTime() - Date.now();
  }
  if (status === 429) return 60_000;
  if (status === 400 || status === 404) return 60 * 60_000;
  return 0;
}

async function callGroqOnce(model: string, key: string, userPrompt: string): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    temperature: 0.3,
    max_tokens: model.includes('gpt-oss') ? 1800 : 3000,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  };
  if (model.includes('gpt-oss')) body.reasoning_effort = 'medium';

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data?.error?.message || `Groq responded with ${response.status}`;
    const err = new Error(message) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Groq returned an empty response');
  return content.trim();
}

async function callGroq(
  env: Record<string, string>,
  userPrompt: string,
): Promise<{ analysis: string; model: string }> {
  const key = env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY is not set in .env');

  const preferred = env.GROQ_MODEL?.trim() || GROQ_MODEL_CHAIN[0];
  const chain = [preferred, ...GROQ_MODEL_CHAIN.filter((m) => m !== preferred)];

  let lastError: Error | null = null;
  let attempted = 0;

  for (const model of chain) {
    const until = groqCooldowns.get(model) ?? 0;
    if (until > Date.now()) continue;
    attempted++;
    try {
      const analysis = await callGroqOnce(model, key, userPrompt);
      groqCooldowns.delete(model);
      return { analysis, model };
    } catch (err) {
      const e = err as Error & { status?: number };
      if (e.status === 401 || e.status === 403) throw e;
      lastError = e;
      const cooldown = groqCooldown(e.status ?? 0, e.message);
      if (cooldown > 0) groqCooldowns.set(model, Date.now() + cooldown);
    }
  }

  if (attempted === 0) {
    throw new Error('All Groq models are rate-limited — try again in a minute');
  }
  throw lastError ?? new Error('Groq request failed');
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

  const { seg, path, symbol, name, from, to, question } = body;
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
    const prompt = buildPrompt({ seg, path, symbol, name, from, to, question }, stats, series, news, period);
    const { analysis, model } = await callGroq(env, prompt);

    sendJson(res, 200, {
      analysis,
      stats,
      news,
      model,
    });
  } catch (err) {
    sendJson(res, 502, { error: err instanceof Error ? err.message : 'Request failed' });
  }
}

async function handleNews(
  req: Connect.IncomingMessage,
  res: Connect.ServerResponse,
  env: Record<string, string>,
) {
  let body: { seg: string; path: string; symbol: string; name: string; ranges: { from: number; to: number }[] };
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON body' });
  }

  const { seg, path, symbol, name, ranges } = body;
  if (!ALLOWED_SEGMENTS.has(String(seg))) return sendJson(res, 400, { error: 'Invalid symbol type' });
  if (!path || !/^[A-Za-z0-9._\-/]+$/.test(path) || path.includes('..')) {
    return sendJson(res, 400, { error: 'Invalid symbol' });
  }
  if (!Array.isArray(ranges) || ranges.length === 0 || ranges.length > 10) {
    return sendJson(res, 400, { error: 'Invalid ranges (1-10 required)' });
  }

  for (const r of ranges) {
    if (typeof r.from !== 'number' || typeof r.to !== 'number' || !Number.isFinite(r.from) || !Number.isFinite(r.to) || r.from >= r.to) {
      return sendJson(res, 400, { error: 'Invalid range' });
    }
  }

  try {
    const results = await Promise.allSettled(
      ranges.map((r) => fetchNews(name, symbol, r.from, r.to).catch(() => [] as NewsItem[])),
    );
    const newsByRange = results.map((r, i) => ({
      range: ranges[i],
      news: r.status === 'fulfilled' ? r.value : [],
    }));
    sendJson(res, 200, { newsByRange });
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
        if (req.url.startsWith('/api/news') && req.method === 'POST') {
          void handleNews(req, res, env);
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
  historical = false,
) {
  if (candles.length === 0) {
    sendJson(res, 404, { error: 'No price data for that period' });
    return;
  }
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  if (historical) {
    const change = prev ? last.close - prev.close : 0;
    sendJson(res, 200, {
      symbol: q?.symbol || fallbackSymbol,
      exchange: q?.ex || '',
      marketState: '',
      price: last.close,
      change,
      changePct: prev && prev.close !== 0 ? (change / prev.close) * 100 : 0,
      previousClose: prev?.close ?? last.close,
      candles,
    });
    return;
  }
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

      const endParam = url.searchParams.get('end');
      const endDate = endParam && /^\d{4}-\d{2}-\d{2}$/.test(endParam) ? endParam : null;
      const isHistorical = range !== 'MAX' && endDate !== null;

      let candles: Candle[] | null = null;
      if (env.TWELVE_DATA_API_KEY && (isHistorical || range === '1D' || range === '5D' || range === 'MAX')) {
        try {
          if (isHistorical) {
            const endEpoch = exchangeDateToEpoch(endDate!);
            const startEpoch = endEpoch - (fetchSpec.days ?? 31) * DAY;
            if (range === '1D') {
              try {
                const bars = await twelveTimeSeries(path, '5min', 300, env.TWELVE_DATA_API_KEY, {
                  from: startEpoch,
                  to: endEpoch + DAY,
                });
                candles = keepRTH(bars);
              } catch {
                candles = dedupeToDays(
                  await twelveTimeSeries(
                    path,
                    '1day',
                    Math.min(5000, (fetchSpec.days ?? 1) + 10),
                    env.TWELVE_DATA_API_KEY,
                    { from: startEpoch, to: endEpoch + DAY },
                  ),
                  1,
                );
              }
            } else if (range === '5D' && endEpoch > Date.now() / 1000 - 730 * DAY) {
              candles = dedupeToDays(
                keepRTH(
                  await twelveTimeSeries(path, '15min', 500, env.TWELVE_DATA_API_KEY, {
                    from: startEpoch,
                    to: endEpoch + DAY,
                  }),
                ),
                5,
              );
            } else {
              candles = await twelveTimeSeries(
                path,
                '1day',
                Math.min(5000, (fetchSpec.days ?? 31) + 10),
                env.TWELVE_DATA_API_KEY,
                { from: startEpoch, to: endEpoch + DAY },
              );
            }
          } else if (range === '1D') {
            candles = dedupeToDays(
              keepRTH(await twelveTimeSeries(path, '5min', 300, env.TWELVE_DATA_API_KEY)),
              1,
            );
          } else if (range === '5D') {
            candles = dedupeToDays(
              keepRTH(await twelveTimeSeries(path, '15min', 500, env.TWELVE_DATA_API_KEY)),
              5,
            );
          } else {
            candles = await twelveTimeSeries(path, '1month', 1000, env.TWELVE_DATA_API_KEY);
          }
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
        if (isHistorical) {
          const endEpoch = exchangeDateToEpoch(endDate!);
          const startEpoch = endEpoch - (fetchSpec.days ?? 31) * DAY;
          candles = candles.filter((c) => c.time >= startEpoch && c.time <= endEpoch);
        } else if (fetchSpec.trimDays) {
          const cutoff = Date.now() / 1000 - fetchSpec.trimDays * DAY;
          candles = candles.filter((c) => c.time >= cutoff);
        } else if (fetchSpec.keepLast) {
          candles = candles.slice(-fetchSpec.keepLast);
        }
      }

      const q = quote.status === 'fulfilled' ? quote.value?.data : null;
      return sendChartResponse(res, q, candles, path.split('/').pop(), isHistorical);
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
