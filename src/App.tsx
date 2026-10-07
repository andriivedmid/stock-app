import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  explainRange,
  fetchChart,
  fetchResolution,
  RANGES,
  type Candle,
  type ChartData,
  type ExplainResult,
  type Quote,
  type RangeKey,
  type ResolutionInterval,
  type Selection,
} from './api';
import { SearchBar } from './SearchBar';
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

type DetailSegment = { from: number; to: number; candles: Candle[] };

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

const PCT_TOKEN = /([+\-−‐‑]?\s*\d+(?:\.\d+)?\s*%)/g;

function colorizePercents(text: string): React.ReactNode[] {
  return text.split(PCT_TOKEN).map((part, idx) => {
    if (!part) return null;
    const m = /^\s*([+\-−‐‑]?)\s*(\d+(?:\.\d+)?)\s*%$/.exec(part);
    if (!m) return <Fragment key={idx}>{part}</Fragment>;
    const negative = m[1] === '-' || m[1] === '−' || m[1] === '‐' || m[1] === '‑';
    return (
      <span key={idx} className={negative ? 'down' : 'up'}>
        {part}
      </span>
    );
  });
}

function renderInline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  for (let idx = 0; idx < parts.length; idx++) {
    const part = parts[idx];
    if (!part) continue;
    if (part.startsWith('**') && part.endsWith('**')) {
      out.push(<strong key={idx}>{colorizePercents(part.slice(2, -2))}</strong>);
    } else {
      out.push(...colorizePercents(part));
    }
  }
  return out;
}

function renderAnalysis(text: string) {
  const blocks: { type: 'p' | 'li'; text: string }[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^[-*•]\s+/.test(trimmed)) {
      blocks.push({ type: 'li', text: trimmed.replace(/^[-*•]\s+/, '') });
    } else {
      blocks.push({ type: 'p', text: trimmed });
    }
  }
  return blocks.map((b, i) =>
    b.type === 'li' ? <li key={i}>{renderInline(b.text)}</li> : <p key={i}>{renderInline(b.text)}</p>,
  );
}

export function App() {
  const [quote, setQuote] = useState<Quote>(DEFAULT_QUOTE);
  const [range, setRange] = useState<RangeKey>('1Y');
  const [chartType, setChartType] = useState<ChartType>('candle');
  const [data, setData] = useState<ChartData | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [explain, setExplain] = useState<ExplainState>({ status: 'idle' });
  const [segments, setSegments] = useState<DetailSegment[]>([]);
  const [preserveView, setPreserveView] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolutionError, setResolutionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setError(null);
    setSelection(null);
    setExplain({ status: 'idle' });
    setSegments([]);
    setPreserveView(false);
    setResolving(false);
    setResolutionError(null);
    fetchChart(quote, range)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load data');
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [quote, range]);

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
      });
      setExplain({ status: 'ready', result });
    } catch (err) {
      setExplain({ status: 'error', error: err instanceof Error ? err.message : 'Request failed' });
    }
  }, [selection, status, quote]);

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
        setSegments((prev) => [...prev, { from, to, candles: res.candles }]);
        setPreserveView(true);
      } catch (err) {
        setResolutionError(err instanceof Error ? err.message : 'Failed to load finer data');
      } finally {
        setResolving(false);
      }
    },
    [quote],
  );

  const activeCandles = useMemo(() => {
    const base = data?.candles;
    if (!base) return [];
    if (segments.length === 0) return base;
    const detail = new Map<number, Candle>();
    for (const s of segments) {
      for (const t of Array.from(detail.keys())) {
        if (t >= s.from && t <= s.to) detail.delete(t);
      }
      for (const c of s.candles) detail.set(c.time, c);
    }
    const merged: Candle[] = [];
    for (const c of base) {
      if (detail.has(c.time)) continue;
      if (segments.some((s) => c.time >= s.from && c.time <= s.to)) continue;
      merged.push(c);
    }
    for (const c of detail.values()) merged.push(c);
    merged.sort((a, b) => a.time - b.time);
    return merged;
  }, [data, segments]);

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
                <button
                  className={`select-toggle ${selectionMode ? 'active' : ''}`}
                  onClick={() => setSelectionMode((m) => !m)}
                  aria-pressed={selectionMode}
                >
                  Select period
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
                <span className="hint">Drag across the chart to highlight a period.</span>
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

            {status === 'ready' && data && activeCandles.length > 0 && (
              <StockChart
                candles={activeCandles}
                chartType={chartType}
                selectionMode={selectionMode}
                selection={selection}
                onSelectRange={handleSelectRange}
                onRequestResolution={requestResolution}
                preserveView={preserveView}
                resolutionLoading={resolving}
                resolutionError={resolutionError}
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
