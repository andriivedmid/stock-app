import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  explainRange,
  fetchChart,
  fetchNewsForMoves,
  fetchResolution,
  RANGES,
  type ChartData,
  type Candle,
  type DetailSegment,
  type ExplainResult,
  type NewsMarker,
  type Quote,
  type RangeKey,
  type ResolutionInterval,
  type Selection,
} from './api';
import { SearchBar } from './SearchBar';
import { DatePicker } from './DatePicker';
import { StockChart, type ChartType } from './StockChart';

const DEFAULT_QUOTE: Quote = {
  symbol: 'AAPL',
  name: 'Apple Inc.',
  path: 'AAPL',
  seg: 's',
  type: 'Stock',
};

const MARKET_STATE: Record<string, string> = {
  open: 'Market open',
  closed: 'Market closed',
  pre: 'Pre-market',
  post: 'After hours',
};

type Status = 'loading' | 'ready' | 'error';

type ExplainState = { status: 'idle' } | { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; result: ExplainResult };

function formatDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function fmtVolume(volume: number): string {
  if (volume >= 1e9) return (volume / 1e9).toFixed(2) + 'B';
  if (volume >= 1e6) return (volume / 1e6).toFixed(1) + 'M';
  if (volume >= 1e3) return (volume / 1e3).toFixed(0) + 'K';
  return String(volume);
}

function renderInline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  for (let idx = 0; idx < parts.length; idx++) {
    const part = parts[idx];
    if (!part) continue;
    if (part.startsWith('**') && part.endsWith('**')) {
      out.push(<strong key={idx}>{part.slice(2, -2)}</strong>);
    } else {
      // Bold signed percentages (+X% or -X%) without color
      const pctParts = part.split(/([+\-]\d+(?:\.\d+)?\s*%)/g);
      for (let i = 0; i < pctParts.length; i++) {
        const p = pctParts[i];
        if (!p) continue;
        if (/^[+\-]\d+(?:\.\d+)?\s*%$/.test(p)) {
          out.push(<strong key={`${idx}-${i}`}>{p}</strong>);
        } else {
          out.push(<Fragment key={`${idx}-${i}`}>{p}</Fragment>);
        }
      }
    }
  }
  return out;
}

const RANGE_NEWS_COUNT: Record<RangeKey, number> = {
  '1D': 3,
  '5D': 3,
  '1M': 3,
  '3M': 3,
  '6M': 3,
  '1Y': 3,
  '5Y': 5,
  'MAX': 10,
};

const RANGE_MODE: Record<RangeKey, 'day' | 'week' | 'month'> = {
  '1D': 'day',
  '5D': 'day',
  '1M': 'day',
  '3M': 'day',
  '6M': 'day',
  '1Y': 'week',
  '5Y': 'month',
  'MAX': 'month',
};

function findBiggestMoves(candles: Candle[], range: RangeKey): { from: number; to: number }[] {
  if (candles.length < 2) return [];

  const targetCount = Math.min(RANGE_NEWS_COUNT[range] ?? 3, 10);
  const mode = RANGE_MODE[range] ?? 'month';

  // Build candidate moves in the range's mode.
  const candidates: { from: number; to: number; pct: number; monthKey: string }[] = [];

  if (mode === 'day') {
    // Single-day events: the biggest single-day price moves.
    for (let i = 1; i < candles.length; i++) {
      const prev = candles[i - 1];
      const curr = candles[i];
      if (prev.close === 0) continue;
      const pct = ((curr.close - prev.close) / prev.close) * 100;
      const d = new Date(curr.time * 1000);
      candidates.push({ from: curr.time, to: curr.time, pct, monthKey: `${d.getUTCFullYear()}-${d.getUTCMonth()}` });
    }
  } else if (mode === 'week') {
    // Single-week events: the biggest 5-trading-day windows.
    for (let i = 5; i < candles.length; i++) {
      const prev = candles[i - 5];
      const curr = candles[i];
      if (prev.close === 0) continue;
      const pct = ((curr.close - prev.close) / prev.close) * 100;
      const d = new Date(curr.time * 1000);
      candidates.push({ from: candles[i - 4].time, to: curr.time, pct, monthKey: `${d.getUTCFullYear()}-${d.getUTCMonth()}` });
    }
  } else {
    // Month mode: month-over-month changes with exact calendar-month ranges.
    const monthMap = new Map<string, { lastClose: number; lastTime: number; year: number; month: number }>();
    for (const c of candles) {
      const d = new Date(c.time * 1000);
      const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
      const existing = monthMap.get(key);
      if (!existing || c.time > existing.lastTime) {
        monthMap.set(key, { lastClose: c.close, lastTime: c.time, year: d.getUTCFullYear(), month: d.getUTCMonth() });
      }
    }
    const months = Array.from(monthMap.values()).sort((a, b) => a.lastTime - b.lastTime);
    for (let i = 1; i < months.length; i++) {
      const prev = months[i - 1];
      const curr = months[i];
      if (prev.lastClose === 0) continue;
      const pct = ((curr.lastClose - prev.lastClose) / prev.lastClose) * 100;
      const from = Math.floor(Date.UTC(curr.year, curr.month, 1) / 1000);
      const to = Math.floor(Date.UTC(curr.year, curr.month + 1, 1) / 1000) - 1;
      candidates.push({ from, to, pct, monthKey: `${curr.year}-${curr.month}` });
    }
  }

  // Keep the single biggest move per calendar month so dots never cluster.
  const bestPerMonth = new Map<string, { from: number; to: number; pct: number }>();
  for (const m of candidates) {
    const existing = bestPerMonth.get(m.monthKey);
    if (!existing || Math.abs(m.pct) > Math.abs(existing.pct)) {
      bestPerMonth.set(m.monthKey, { from: m.from, to: m.to, pct: m.pct });
    }
  }
  const perMonth = Array.from(bestPerMonth.values());

  if (range === 'MAX') {
    // Guarantee a story every 5 years, then fill the remainder with the biggest moves.
    const years = perMonth.map((m) => new Date(m.from * 1000).getUTCFullYear());
    const firstYear = Math.min(...years);
    const lastYear = Math.max(...years);
    const selected: { from: number; to: number; pct: number }[] = [];
    const used = new Set<string>();

    for (let y = firstYear; y <= lastYear; y += 5) {
      const blockEnd = y + 4;
      let best: { from: number; to: number; pct: number } | null = null;
      let bestKey = '';
      for (const m of perMonth) {
        const year = new Date(m.from * 1000).getUTCFullYear();
        if (year >= y && year <= blockEnd) {
          const d = new Date(m.from * 1000);
          const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
          if (used.has(key)) continue;
          if (!best || Math.abs(m.pct) > Math.abs(best.pct)) {
            best = m;
            bestKey = key;
          }
        }
      }
      if (best) {
        selected.push(best);
        used.add(bestKey);
      }
    }

    const sorted = [...perMonth].sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
    for (const m of sorted) {
      if (selected.length >= targetCount) break;
      const d = new Date(m.from * 1000);
      const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
      if (used.has(key)) continue;
      selected.push(m);
      used.add(key);
    }

    selected.sort((a, b) => a.from - b.from);
    return selected.slice(0, 10).map((m) => ({ from: m.from, to: m.to }));
  }

  // Other ranges: biggest moves across distinct months.
  const perMonthSorted = [...perMonth].sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  const selected = perMonthSorted.slice(0, targetCount);
  selected.sort((a, b) => a.from - b.from);
  return selected.map((m) => ({ from: m.from, to: m.to }));
}

function renderAnalysis(text: string) {
  const blocks: { type: 'p' | 'li' | 'h3' | 'h4'; text: string }[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const h = /^(#{1,2})\s+(.*)$/.exec(trimmed);
    if (h) {
      blocks.push({ type: h[1].length === 1 ? 'h3' : 'h4', text: h[2] });
      continue;
    }
    if (/^[-*•]\s+/.test(trimmed)) {
      blocks.push({ type: 'li', text: trimmed.replace(/^[-*•]\s+/, '') });
    } else {
      blocks.push({ type: 'p', text: trimmed });
    }
  }
  return blocks.map((b, i) => {
    if (b.type === 'li') return <li key={i}>{renderInline(b.text)}</li>;
    if (b.type === 'h3')
      return (
        <h3 key={i} className="analysis-headline">
          {renderInline(b.text)}
        </h3>
      );
    if (b.type === 'h4') return <h4 key={i}>{renderInline(b.text)}</h4>;
    return <p key={i}>{renderInline(b.text)}</p>;
  });
}

export function App() {
  const [quote, setQuote] = useState<Quote>(DEFAULT_QUOTE);
  const [range, setRange] = useState<RangeKey>('1Y');
  const [endDateInput, setEndDateInput] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [chartType, setChartType] = useState<ChartType>('candle');
  const [data, setData] = useState<ChartData | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [explain, setExplain] = useState<ExplainState>({ status: 'idle' });
  const [explainQuestion, setExplainQuestion] = useState<string>('');
  const [segments, setSegments] = useState<DetailSegment[]>([]);
  const [resolving, setResolving] = useState(false);
  const [resolutionError, setResolutionError] = useState<string | null>(null);
  const [newsMarkers, setNewsMarkers] = useState<NewsMarker[]>([]);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setError(null);
    setSelection(null);
    setExplain({ status: 'idle' });
    setSegments([]);
    setResolving(false);
    setResolutionError(null);
    fetchChart(quote, range, endDate)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setStatus('ready');
        const moves = findBiggestMoves(res.candles, range);
        if (moves.length > 0) {
          console.log('[news] found moves:', moves.length, moves);
          fetchNewsForMoves(quote.seg, quote.path, quote.symbol, quote.name, moves)
            .then((newsByRange) => {
              if (cancelled) return;
              console.log('[news] response:', newsByRange);
              const markers: NewsMarker[] = newsByRange
                .filter((nr) => nr.news.length > 0)
                .map((nr) => ({
                  time: Math.floor((nr.range.from + nr.range.to) / 2),
                  news: nr.news,
                }));
              console.log('[news] markers:', markers);
              setNewsMarkers(markers);
            })
            .catch((err) => console.error('[news] fetch failed:', err));
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load data');
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [quote, range, endDate]);

  const onSelect = useCallback((next: Quote) => setQuote(next), []);

  const handleSelectRange = useCallback((sel: Selection | null) => {
    setSelection(sel);
    setExplain({ status: 'idle' });
  }, []);

  const runExplain = useCallback(async () => {
    if (!selection || status !== 'ready') return;
    setExplain({ status: 'loading' });
    try {
      const result = await explainRange({
        seg: quote.seg,
        path: quote.path,
        symbol: quote.symbol,
        name: quote.name,
        from: selection.from,
        to: selection.to,
        question: explainQuestion,
      });
      setExplain({ status: 'ready', result });
      setExplainQuestion('');
    } catch (err) {
      setExplain({ status: 'error', error: err instanceof Error ? err.message : 'Request failed' });
    }
  }, [selection, status, quote, explainQuestion]);

  const clearSelection = useCallback(() => {
    setSelection(null);
    setExplain({ status: 'idle' });
  }, []);

  const requestResolution = useCallback(
    async (from: number, to: number, interval: ResolutionInterval) => {
      setResolving(true);
      setResolutionError(null);
      try {
        const res = await fetchResolution(quote, from, to, interval);
        setSegments((prev) => [...prev, { from, to, candles: res.candles, interval }]);
      } catch (err) {
        setResolutionError(err instanceof Error ? err.message : 'Failed to load finer data');
      } finally {
        setResolving(false);
      }
    },
    [quote],
  );

  const up = data ? data.change >= 0 : true;
  const marketLabel = data ? MARKET_STATE[data.marketState] : '';
  const stats = explain.status === 'ready' ? explain.result.stats : null;
  const news = explain.status === 'ready' ? explain.result.news.slice(0, 6) : [];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">▲</span> StockViewer
        </div>
        <SearchBar onSelect={onSelect} selected={quote} />
      </header>

      <main className="content">
        <section className="panel">
          <div className="quote-header">
            <div className="quote-id">
              <h1>
                {quote.name}
                <span className="quote-symbol">{data?.symbol ?? quote.symbol}</span>
              </h1>
              <span className="quote-meta">
                {[quote.type, data?.exchange, marketLabel].filter(Boolean).join(' · ')}
              </span>
            </div>

            <div className="quote-price">
              {status === 'ready' && data ? (
                <>
                  <span className="price-value">{data.price.toFixed(2)}</span>
                  <span className={`price-change ${up ? 'up' : 'down'}`}>
                    {up ? '▲' : '▼'} {Math.abs(data.change).toFixed(2)} (
                    {data.changePct.toFixed(2)}%)
                  </span>
                </>
              ) : (
                <span className="price-value muted">—</span>
              )}
            </div>

            <div className="controls">
              <div className="segmented" role="group" aria-label="Chart type">
                <button
                  className={chartType === 'candle' ? 'active' : ''}
                  onClick={() => setChartType('candle')}
                >
                  Candles
                </button>
                <button
                  className={chartType === 'line' ? 'active' : ''}
                  onClick={() => setChartType('line')}
                >
                  Line
                </button>
              </div>
              <div className="controls-row">
                <div className="ranges" role="group" aria-label="Time range">
                  {RANGES.map((r) => (
                    <button
                      key={r}
                      className={range === r ? 'active' : ''}
                      onClick={() => setRange(r)}
                    >
                      {r}
                    </button>
                  ))}
                </div>
                <div className={`end-date-group ${range === 'MAX' ? 'disabled' : ''}`}>
                  <span className="end-date-label" aria-hidden="true">End on</span>
                  <DatePicker
                    value={endDateInput}
                    min="1900-01-01"
                    max={new Date().toISOString().slice(0, 10)}
                    disabled={range === 'MAX'}
                    onChange={setEndDateInput}
                  />
                  <button
                    type="button"
                    className={`end-date-load ${endDateInput && range !== 'MAX' ? '' : 'hidden'}`}
                    onClick={() => {
                      setEndDate(endDateInput);
                      setSelection(null);
                      setExplain({ status: 'idle' });
                    }}
                    title="Load the graph ending on this date"
                  >
                    Load
                  </button>
                  <button
                    type="button"
                    className={`clear-date-btn ${(endDateInput || endDate) && range !== 'MAX' ? '' : 'hidden'}`}
                    onClick={() => {
                      setEndDate('');
                      setEndDateInput('');
                    }}
                    title="Clear end date"
                  >
                    ✕
                  </button>
                </div>
                <button
                  className={`select-toggle ${selectionMode ? 'active' : ''}`}
                  onClick={() => setSelectionMode((m) => !m)}
                  aria-pressed={selectionMode}
                >
                  Analyse period
                </button>
              </div>
            </div>
          </div>

          {(selectionMode || selection) && (
            <div className="selection-bar">
              {selection ? (
                <>
                  <span className="selection-range">
                    {formatDate(selection.from)} → {formatDate(selection.to)}
                  </span>
                  <input
                    type="text"
                    className="explain-question"
                    placeholder="Ask a question about this period…"
                    value={explainQuestion}
                    onChange={(e) => setExplainQuestion(e.target.value)}
                    disabled={explain.status === 'loading'}
                  />
                  <button
                    className="explain-btn"
                    onClick={runExplain}
                    disabled={explain.status === 'loading'}
                  >
                    {explain.status === 'loading' ? 'Researching…' : '✦ Explain with AI'}
                  </button>
                  <button className="ghost-btn" onClick={clearSelection}>
                    Clear
                  </button>
                </>
              ) : (
                <span className="hint">Drag across the chart to highlight a period for AI analysis.</span>
              )}
              <button
                className="ghost-btn mode-off"
                onClick={() => {
                  setSelectionMode(false);
                  if (!selection) setExplain({ status: 'idle' });
                }}
              >
                Done
              </button>
            </div>
          )}

          <div className="chart-area">
            {status === 'loading' && (
              <div className="overlay">
                <div className="spinner" />
                <p>Loading {quote.symbol}…</p>
              </div>
            )}

            {status === 'error' && (
              <div className="overlay">
                <p className="error-message">{error ?? 'Something went wrong'}</p>
                <button className="retry" onClick={() => setQuote({ ...quote })}>
                  Retry
                </button>
              </div>
            )}

            {status === 'ready' && data && data.candles.length === 0 && (
              <div className="overlay">
                <p>No price data available for {data.symbol} in this range.</p>
              </div>
            )}

            {status === 'ready' && data && data.candles.length > 0 && (
              <StockChart
                candles={data.candles}
                segments={segments}
                chartType={chartType}
                selectionMode={selectionMode}
                selection={selection}
                onSelectRange={handleSelectRange}
                onRequestResolution={requestResolution}
                resolutionLoading={resolving}
                resolutionError={resolutionError}
                newsMarkers={newsMarkers}
              />
            )}
          </div>

          {explain.status === 'loading' && (
            <div className="analysis">
              <div className="analysis-loading">
                <div className="spinner" />
                <p>Researching price action and headlines…</p>
              </div>
            </div>
          )}

          {explain.status === 'error' && (
            <div className="analysis">
              <p className="error-message">{explain.error}</p>
              <button className="retry" onClick={runExplain}>
                Try again
              </button>
            </div>
          )}

          {explain.status === 'ready' && stats && (
            <div className="analysis">
              <div className="analysis-header">
                <span className="analysis-title">What happened</span>
                <span className="analysis-model">
                  {explain.result.model} · news via Google News
                </span>
              </div>

              <div className="analysis-body">{renderAnalysis(explain.result.analysis)}</div>

              <div className="stats-grid">
                <div className="stat">
                  <span className="stat-label">Period change</span>
                  <span className={`stat-value ${stats.pctChange >= 0 ? 'up' : 'down'}`}>
                    {stats.pctChange >= 0 ? '+' : ''}
                    {stats.pctChange.toFixed(2)}%
                  </span>
                </div>
                <div className="stat">
                  <span className="stat-label">High / Low</span>
                  <span className="stat-value">
                    {stats.high.toFixed(2)} / {stats.low.toFixed(2)}
                  </span>
                </div>
                {stats.maxGain && (
                  <div className="stat">
                    <span className="stat-label">Best day</span>
                    <span className="stat-value up">
                      {stats.maxGain.date} +{stats.maxGain.pct.toFixed(2)}%
                    </span>
                  </div>
                )}
                {stats.maxDrop && (
                  <div className="stat">
                    <span className="stat-label">Worst day</span>
                    <span className="stat-value down">
                      {stats.maxDrop.date} {stats.maxDrop.pct.toFixed(2)}%
                    </span>
                  </div>
                )}
                <div className="stat">
                  <span className="stat-label">Max drawdown</span>
                  <span className="stat-value down">{stats.drawdownPct.toFixed(2)}%</span>
                </div>
                <div className="stat">
                  <span className="stat-label">Avg volume</span>
                  <span className="stat-value">{fmtVolume(stats.avgVolume)}</span>
                </div>
                {stats.relVolume !== null && stats.relVolume !== undefined && (
                  <div className="stat">
                    <span className="stat-label">Volume vs prior</span>
                    <span className="stat-value">{stats.relVolume.toFixed(2)}x</span>
                  </div>
                )}
                {stats.volumeSpikes.length > 0 && (
                  <div className="stat stat-wide">
                    <span className="stat-label">Volume spikes (&gt;2x prior)</span>
                    <span className="stat-value">
                      {stats.volumeSpikes
                        .slice(0, 3)
                        .map((s) => `${s.date} ${fmtVolume(s.volume)}`)
                        .join(' · ')}
                    </span>
                  </div>
                )}
              </div>

              {news.length > 0 && (
                <div className="news-block">
                  <span className="news-title">Headlines in this period</span>
                  <ul className="news-list">
                    {news.map((n, i) => (
                      <li key={i}>
                        <span className="news-date">{n.date}</span>
                        <span className="news-headline">{n.title}</span>
                        {n.source && <span className="news-source">{n.source}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>

        <footer className="footer">
          Market data provided by stockanalysis.com. Analysis generated by Groq.
        </footer>
      </main>
    </div>
  );
}
