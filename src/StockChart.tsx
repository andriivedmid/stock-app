import { useEffect, useRef, useState } from 'react';
import {
  AreaSeries,
  CandlestickSeries,
  CrosshairMode,
  HistogramSeries,
  createChart,
  type BusinessDay,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type AreaData,
  type SeriesType,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle, ResolutionInterval, Selection } from './api';

export type ChartType = 'candle' | 'line';

const EXCHANGE_TZ = 'America/New_York';

function formatChartTime(seconds: number, withTime: boolean): string {
  return new Date(seconds * 1000).toLocaleString('en-US', {
    timeZone: EXCHANGE_TZ,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  });
}

const DAY_S = 86400;

type Granularity = 'monthly' | 'daily' | 'intraday' | 'unknown';

function classifyGranularity(candles: Candle[]): Granularity {
  if (candles.length < 3) return 'unknown';
  const gaps: number[] = [];
  for (let i = 1; i < candles.length; i++) gaps.push(candles[i].time - candles[i - 1].time);
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  if (median >= 14 * DAY_S) return 'monthly';
  if (median >= 12 * 3600) return 'daily';
  return 'intraday';
}

function timeToSeconds(time: unknown): number | null {
  if (typeof time === 'number') return time;
  if (time && typeof time === 'object' && 'year' in (time as object)) {
    const bd = time as { year: number; month: number; day: number };
    return Date.UTC(bd.year, bd.month - 1, bd.day) / 1000;
  }
  return null;
}

function formatShortDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString('en-US', {
    timeZone: EXCHANGE_TZ,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

type Props = {
  candles: Candle[];
  chartType: ChartType;
  selectionMode: boolean;
  selection: Selection | null;
  onSelectRange: (sel: Selection | null) => void;
  onRequestResolution: (from: number, to: number, interval: ResolutionInterval) => void;
  preserveView: boolean;
  resolutionLoading: boolean;
  resolutionError: string | null;
};

type HoverInfo = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  prevClose: number | null;
  up: boolean;
} | null;

type Band = { left: number; width: number };

type DragState = { anchorTime: number; anchorX: number; moved: boolean };

function formatVolume(value: number): string {
  if (value >= 1e9) return (value / 1e9).toFixed(2) + 'B';
  if (value >= 1e6) return (value / 1e6).toFixed(2) + 'M';
  if (value >= 1e3) return (value / 1e3).toFixed(2) + 'K';
  return String(value);
}

export function StockChart({
  candles,
  chartType,
  selectionMode,
  selection,
  onSelectRange,
  onRequestResolution,
  preserveView,
  resolutionLoading,
  resolutionError,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const volumeRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const byTimeRef = useRef<Map<number, Candle>>(new Map());
  const prevCloseByTimeRef = useRef<Map<number, number>>(new Map());
  const nearestTimeRef = useRef<(t: number) => number | null>(() => null);
  const timesRef = useRef<number[]>([]);
  const dragRef = useRef<DragState | null>(null);
  const prevCandlesRef = useRef<Candle[] | null>(null);
  const selectCallbackRef = useRef(onSelectRange);
  const [hover, setHover] = useState<HoverInfo>(null);
  const [dragLive, setDragLive] = useState<Band | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [coordTick, setCoordTick] = useState(0);

  function showTimeAround(t: number): boolean {
    const times = timesRef.current;
    if (times.length < 2) return false;
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    const prev = lo > 0 ? t - times[lo - 1] : Infinity;
    const next = lo < times.length - 1 ? times[lo + 1] - t : Infinity;
    return Math.min(prev, next) < 12 * 3600;
  }

  useEffect(() => {
    selectCallbackRef.current = onSelectRange;
  }, [onSelectRange]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    prevCandlesRef.current = null;

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { color: '#0b0e11' },
        textColor: '#8b949e',
        fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
        fontSize: 12,
      },
      grid: {
        vertLines: { color: 'rgba(139, 148, 158, 0.08)' },
        horzLines: { color: 'rgba(139, 148, 158, 0.08)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(139, 148, 158, 0.4)', labelBackgroundColor: '#30363d' },
        horzLine: { color: 'rgba(139, 148, 158, 0.4)', labelBackgroundColor: '#30363d' },
      },
      rightPriceScale: { borderColor: '#21262d' },
      timeScale: {
        borderColor: '#21262d',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6,
      },
      localization: {
        timeFormatter: (time: UTCTimestamp | BusinessDay) => {
          const ts =
            typeof time === 'number'
              ? time
              : Date.UTC(time.year, time.month - 1, time.day) / 1000;
          return formatChartTime(ts, showTimeAround(ts));
        },
      },
      handleScroll: true,
      handleScale: true,
    });

    const volumePane = chart.addPane(true);
    volumePane.setStretchFactor(1);
    const volumeSeries = chart.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: 'volume' },
        priceScaleId: 'volume',
        lastValueVisible: false,
        priceLineVisible: false,
      },
      1,
    );
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.25, bottom: 0 } });

    chart.subscribeCrosshairMove((param) => {
      if (!param.time) {
        setHover(null);
        return;
      }
      const candle = byTimeRef.current.get(param.time as number);
      if (!candle) {
        setHover(null);
        return;
      }
      const prevClose = prevCloseByTimeRef.current.get(candle.time) ?? null;
      setHover({
        ...candle,
        prevClose,
        up: prevClose !== null ? candle.close >= prevClose : candle.close >= candle.open,
      });
    });

    chart.timeScale().subscribeVisibleTimeRangeChange(() => setCoordTick((t) => t + 1));

    chartRef.current = chart;
    volumeRef.current = volumeSeries;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volumeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const previous = seriesRef.current;
    const dataChanged = prevCandlesRef.current !== candles;
    prevCandlesRef.current = candles;

    byTimeRef.current = new Map(candles.map((c) => [c.time, c]));
    const prevByTime = new Map<number, number>();
    for (let i = 1; i < candles.length; i++) {
      prevByTime.set(candles[i].time, candles[i - 1].close);
    }
    prevCloseByTimeRef.current = prevByTime;

    const times = Array.from(byTimeRef.current.keys()).sort((a, b) => a - b);
    timesRef.current = times;
    nearestTimeRef.current = (t: number): number | null => {
      if (times.length === 0) return null;
      let lo = 0;
      let hi = times.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] < t) lo = mid + 1;
        else hi = mid;
      }
      let best = times[lo];
      if (lo > 0 && Math.abs(times[lo - 1] - t) < Math.abs(best - t)) best = times[lo - 1];
      return best;
    };

    let series: ISeriesApi<SeriesType>;
    if (chartType === 'candle') {
      series = chart.addSeries(
        CandlestickSeries,
        {
          upColor: '#26a69a',
          downColor: '#ef5350',
          borderVisible: false,
          wickUpColor: '#26a69a',
          wickDownColor: '#ef5350',
          priceLineVisible: true,
          lastValueVisible: true,
        },
        0,
      );
      const data: CandlestickData<UTCTimestamp>[] = candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));
      series.setData(data as never);
    } else {
      series = chart.addSeries(
        AreaSeries,
        {
          lineColor: '#4c9aff',
          topColor: 'rgba(76, 154, 255, 0.35)',
          bottomColor: 'rgba(76, 154, 255, 0.02)',
          lineWidth: 2,
          priceLineVisible: true,
          lastValueVisible: true,
        },
        0,
      );
      const data: AreaData<UTCTimestamp>[] = candles.map((c) => ({
        time: c.time as UTCTimestamp,
        value: c.close,
      }));
      series.setData(data as never);
    }

    seriesRef.current = series;
    volumeRef.current?.setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        value: c.volume,
        color: c.close >= c.open ? 'rgba(38, 166, 154, 0.45)' : 'rgba(239, 83, 80, 0.45)',
      })) as never,
    );

    if (previous) chart.removeSeries(previous);

    if (dataChanged && !preserveView) {
      chart.timeScale().fitContent();
      setAnchor(null);
    }
    setHover(null);
    setCoordTick((t) => t + 1);
  }, [candles, chartType]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.applyOptions({
      handleScroll: {
        pressedMouseMove: false,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: { time: true },
      },
    });
    const el = containerRef.current;
    if (el) el.style.cursor = 'crosshair';
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const xOf = (e: PointerEvent) => e.clientX - el.getBoundingClientRect().left;
    const timeOf = (x: number) => {
      const t = chartRef.current?.timeScale().coordinateToTime(x);
      return typeof t === 'number' ? t : null;
    };

    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      const x = xOf(e);
      const t = timeOf(x);
      if (t === null) return;
      dragRef.current = { anchorTime: t, anchorX: x, moved: false };
      setDragLive({ left: x, width: 0 });
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
    };

    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const x = xOf(e);
      if (Math.abs(x - d.anchorX) > 4) d.moved = true;
      setDragLive({ left: Math.min(d.anchorX, x), width: Math.abs(x - d.anchorX) });
    };

    const onUp = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      setDragLive(null);
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
      const x = xOf(e);
      const t = timeOf(x);

      if (!d.moved) {
        if (selectionMode) {
          selectCallbackRef.current(null);
          return;
        }
        if (t !== null) {
          const snap = nearestTimeRef.current(t);
          if (snap !== null) setAnchor((cur) => (cur === snap ? null : snap));
        }
        return;
      }

      if (t === null || t === d.anchorTime) return;
      const from = Math.min(d.anchorTime, t);
      const to = Math.max(d.anchorTime, t);
      if (from === to) return;
      chartRef.current?.timeScale().setVisibleRange({
        from: from as UTCTimestamp,
        to: to as UTCTimestamp,
      });
      if (selectionMode) selectCallbackRef.current({ from, to });
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    };
  }, [selectionMode]);

  const shown = hover ?? lastCandle(candles);
  const change = shown
    ? shown.prevClose !== null
      ? shown.close - shown.prevClose
      : shown.close - shown.open
    : 0;
  const colorFor = (value: number, ref: number | null) => (ref === null ? '' : value >= ref ? 'up' : 'down');

  const bandFor = (sel: Selection): Band | null => {
    const chart = chartRef.current;
    if (!chart) return null;
    const c1 = chart.timeScale().timeToCoordinate(sel.from as UTCTimestamp);
    const c2 = chart.timeScale().timeToCoordinate(sel.to as UTCTimestamp);
    if (c1 === null || c2 === null) return null;
    return { left: Math.min(c1, c2), width: Math.abs(c2 - c1) };
  };

  const selectionBand = selection ? bandFor(selection) : null;

  const anchorX =
    anchor !== null && !selectionMode
      ? (() => {
          const x = chartRef.current?.timeScale().timeToCoordinate(anchor as UTCTimestamp);
          return typeof x === 'number' ? x : null;
        })()
      : null;

  let anchorNote: { startTime: number; delta: number; pct: number } | null = null;
  if (hover && anchor !== null) {
    const ac = byTimeRef.current.get(anchor);
    if (ac) {
      const after = hover.time >= anchor;
      const start = after ? ac.close : hover.close;
      const end = after ? hover.close : ac.close;
      const delta = end - start;
      anchorNote = {
        startTime: after ? anchor : hover.time,
        delta,
        pct: start > 0 ? (delta / start) * 100 : 0,
      };
    }
  }

  const dataFirst = candles.length ? candles[0].time : null;
  const dataLast = candles.length ? candles[candles.length - 1].time : null;

  let resolutionPlan: {
    interval: ResolutionInterval;
    from: number;
    to: number;
    label: string;
  } | null = null;
  if (dataFirst !== null && dataLast !== null && chartRef.current) {
    const vr = chartRef.current.timeScale().getVisibleRange();
    const vf = vr ? timeToSeconds(vr.from) : null;
    const vt = vr ? timeToSeconds(vr.to) : null;
    if (vf !== null && vt !== null) {
      const visFrom = Math.max(vf, dataFirst);
      const visTo = Math.min(vt, dataLast);
      const span = visTo - visFrom;
      const spanDays = span / DAY_S;
      if (span > 0) {
        const near = candles.filter((c) => c.time >= vf - span * 2 && c.time <= vt + span * 2);
        const visGran = classifyGranularity(near.length >= 3 ? near : candles);
        const intradayOk = visTo >= Date.now() / 1000 - 730 * DAY_S;
        let interval: ResolutionInterval | null = null;
        if (visGran === 'monthly' || visGran === 'daily') {
          if (spanDays <= 5.5 && intradayOk) interval = '15min';
          else if (visGran === 'monthly' && spanDays <= 1830) interval = 'daily';
        }
        if (interval) {
          const pad = span * 0.05;
          const from = Math.max(Math.floor(visFrom - pad), dataFirst);
          const to = Math.min(Math.ceil(visTo + pad), dataLast);
          const label =
            interval === '15min'
              ? `↻ 15-min bars · ${formatShortDate(from)} – ${formatShortDate(to)}`
              : `↻ Daily bars · ${formatShortDate(from)} – ${formatShortDate(to)}`;
          resolutionPlan = { interval, from, to, label };
        }
      }
    }
  }
  const plan = resolutionPlan;

  return (
    <div className="chart-shell">
      <div className="chart-legend">
        {shown ? (
          <>
            <span className={`legend-time ${shown.up ? 'up' : 'down'}`}>
              {formatChartTime(shown.time, showTimeAround(shown.time))}
            </span>
            <span className="legend-item">
              O <b className={colorFor(shown.open, shown.prevClose)}>{shown.open.toFixed(2)}</b>
            </span>
            <span className="legend-item">
              H <b className={colorFor(shown.high, shown.prevClose)}>{shown.high.toFixed(2)}</b>
            </span>
            <span className="legend-item">
              L <b className={colorFor(shown.low, shown.prevClose)}>{shown.low.toFixed(2)}</b>
            </span>
            <span className="legend-item">
              C <b className={colorFor(shown.close, shown.prevClose)}>{shown.close.toFixed(2)}</b>
            </span>
            <span className="legend-item">
              <b className={shown.up ? 'up' : 'down'}>
                {change >= 0 ? '+' : ''}
                {change.toFixed(2)}
              </b>
            </span>
            <span className="legend-item">
              Vol <b>{formatVolume(shown.volume)}</b>
            </span>
            {anchorNote && (
              <span className="legend-item">
                <b className={anchorNote.delta >= 0 ? 'up' : 'down'}>
                  {anchorNote.delta >= 0 ? '+' : ''}
                  {anchorNote.delta.toFixed(2)} ({anchorNote.pct >= 0 ? '+' : ''}
                  {anchorNote.pct.toFixed(2)}%)
                </b>
                <span className="muted">
                  {' '}since {formatChartTime(anchorNote.startTime, showTimeAround(anchorNote.startTime))}
                </span>
              </span>
            )}
          </>
        ) : (
          <span className="legend-item muted">No data</span>
        )}
      </div>
      <div className="chart-stage" data-coord-tick={coordTick}>
        <div className="chart-canvas" ref={containerRef} />
        {selectionBand && (
          <div
            className="selection-band"
            style={{ left: selectionBand.left, width: selectionBand.width }}
          />
        )}
        {dragLive && (
          <div
            className="selection-band live"
            style={{ left: dragLive.left, width: dragLive.width }}
          />
        )}
        {anchorX !== null && (
          <div className="anchor-line" style={{ left: anchorX }}>
            <button
              className="anchor-close"
              title="Clear anchor"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setAnchor(null)}
            >
              ×
            </button>
          </div>
        )}
        {plan && (
          <div className="resolve-bar">
            <button
              className="resolve-btn"
              disabled={resolutionLoading}
              onClick={() => onRequestResolution(plan.from, plan.to, plan.interval)}
            >
              {resolutionLoading ? 'Loading…' : plan.label}
            </button>
          </div>
        )}
        {resolutionError && <div className="resolve-error">{resolutionError}</div>}
      </div>
    </div>
  );
}

function lastCandle(candles: Candle[]): HoverInfo {
  if (candles.length === 0) return null;
  const c = candles[candles.length - 1];
  const prevClose = candles.length > 1 ? candles[candles.length - 2].close : null;
  return {
    ...c,
    prevClose,
    up: prevClose !== null ? c.close >= prevClose : c.close >= c.open,
  };
}
