export type RangeKey = '1D' | '5D' | '1M' | '3M' | '6M' | '1Y' | '5Y' | 'MAX';

export const RANGES: RangeKey[] = ['1D', '5D', '1M', '3M', '6M', '1Y', '5Y', 'MAX'];

export type Quote = {
  symbol: string;
  name: string;
  path: string;
  seg: string;
  type: string;
};

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type ChartData = {
  symbol: string;
  exchange: string;
  marketState: string;
  price: number;
  change: number;
  changePct: number;
  previousClose: number;
  candles: Candle[];
};

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error || `Request failed (${res.status})`);
  }
  return body as T;
}

export function searchSymbols(query: string): Promise<{ quotes: Quote[] }> {
  return getJson(`/api/search?q=${encodeURIComponent(query)}`);
}

export function fetchChart(quote: Quote, range: RangeKey, end?: string): Promise<ChartData> {
  const params = new URLSearchParams({ seg: quote.seg, path: quote.path, range });
  if (end && range !== 'MAX') params.set('end', end);
  return getJson(`/api/chart?${params.toString()}`);
}

export type ResolutionInterval = '15min' | 'daily';

export type DetailSegment = { from: number; to: number; candles: Candle[]; interval: ResolutionInterval };

export function fetchResolution(
  quote: Quote,
  from: number,
  to: number,
  interval: ResolutionInterval,
): Promise<ChartData> {
  const params = new URLSearchParams({
    seg: quote.seg,
    path: quote.path,
    interval,
    from: String(Math.floor(from)),
    to: String(Math.ceil(to)),
  });
  return getJson(`/api/chart?${params.toString()}`);
}

export type Selection = { from: number; to: number };

export type ExplainStats = {
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

export type NewsItem = { title: string; date: string; source: string };

export type ExplainResult = {
  analysis: string;
  stats: ExplainStats;
  news: NewsItem[];
  model: string;
};

export type NewsMarker = {
  time: number;
  news: NewsItem[];
};

export async function explainRange(payload: {
  seg: string;
  path: string;
  symbol: string;
  name: string;
  from: number;
  to: number;
  question?: string;
}): Promise<ExplainResult> {
  const res = await fetch('/api/explain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error || `Request failed (${res.status})`);
  }
  return body as ExplainResult;
}

export async function fetchNewsForMoves(
  seg: string,
  path: string,
  symbol: string,
  name: string,
  ranges: { from: number; to: number }[],
): Promise<{ range: { from: number; to: number }; news: NewsItem[] }[]> {
  const res = await fetch('/api/news', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seg, path, symbol, name, ranges }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error || `Request failed (${res.status})`);
  }
  return body.newsByRange;
}
