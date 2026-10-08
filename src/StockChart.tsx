import { useEffect, useMemo, useRef, useState } from 'react';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import {
  AreaSeries,
  CandlestickSeries,
  CrosshairMode,
  HistogramSeries,
  createChart,
  type BusinessDay,
  type IChartApi,
  type ISeriesApi,
  type ISeriesPrimitive,
  type SeriesType,
  type UTCTimestamp,
  type WhitespaceData,
} from 'lightweight-charts';
import type { Candle, DetailSegment, ResolutionInterval, Selection, NewsItem, NewsMarker } from './api';

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

function activeSegmentIndices(
  segments: DetailSegment[],
  base: Candle[],
  chart: IChartApi | null,
): number[] {
  if (segments.length === 0 || base.length === 0) return [];
  const vr = chart?.timeScale().getVisibleRange();
  const vf = vr ? timeToSeconds(vr.from) : null;
  const vt = vr ? timeToSeconds(vr.to) : null;
  const cf = vf !== null && vt !== null ? Math.max(vf, base[0].time) : null;
  const ct = vf !== null && vt !== null ? Math.min(vt, base[base.length - 1].time) : null;
  const out: number[] = [];
  const contained = cf !== null && ct !== null && cf <= ct;
  segments.forEach((s, i) => {
    if (s.interval === 'daily') {
      out.push(i);
      return;
    }
    if (contained && cf! >= s.from && ct! <= s.to) out.push(i);
  });
  return out;
}

function buildDayGridTimes(candles: Candle[]): number[] {
  const times: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    times.push(candles[i].time);
    if (i + 1 < candles.length) {
      const gap = candles[i + 1].time - candles[i].time;
      const days = Math.round(gap / DAY_S);
      for (let k = 1; k < days; k++) times.push(candles[i].time + k * DAY_S);
    }
  }
  return times;
}

type WideSpan = {
  time: number;
  end: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

function computeWideSpans(base: Candle[], merged: Candle[]): WideSpan[] {
  const isBase = new Set(base.map((c) => c.time));
  const out: WideSpan[] = [];
  const n = merged.length;
  for (let i = 0; i < n; i++) {
    const c = merged[i];
    if (!isBase.has(c.time)) continue;
    const prevGap = i > 0 ? c.time - merged[i - 1].time : 0;
    const nextGap = i < n - 1 ? merged[i + 1].time - c.time : 0;
    if (Math.max(prevGap, nextGap) < 14 * DAY_S) continue;
    const end = i < n - 1 ? merged[i + 1].time : Infinity;
    if (end !== Infinity && end <= c.time) continue;
    out.push({
      time: c.time,
      end,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    });
  }
  return out;
}

type PrimParam = Parameters<NonNullable<ISeriesPrimitive['attached']>>[0];

function createWideVolumePrimitive(getWides: () => WideSpan[]): ISeriesPrimitive {
  let chart: PrimParam['chart'] | null = null;
  let series: PrimParam['series'] | null = null;

  const renderer = {
    draw(target: CanvasRenderingTarget2D): void {
      if (!chart || !series) return;
      const wides = getWides();
      if (wides.length === 0) return;
      const ts = chart.timeScale();
      target.useBitmapCoordinateSpace((scope) => {
        const { context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr } = scope;
        const canvasW = ctx.canvas.width;
        const canvasH = ctx.canvas.height;
        for (const s of wides) {
          if (s.volume <= 0) continue;
          const x1r = ts.timeToCoordinate(s.time as UTCTimestamp);
          if (x1r === null) continue;
          const x2r = Number.isFinite(s.end)
            ? ts.timeToCoordinate(s.end as UTCTimestamp)
            : null;
          const yTopR = series!.priceToCoordinate(s.volume);
          if (yTopR === null) continue;
          const yBotR = series!.priceToCoordinate(0);
          const x1 = Math.round(x1r * hpr);
          const x2raw = x2r !== null ? Math.round(x2r * hpr) : canvasW;
          const x2 = x2raw - Math.round((x2raw - x1) * 0.1);
          if (x2 <= x1) continue;
          const yTop = Math.round(yTopR * vpr);
          const yBot = yBotR !== null ? Math.round(yBotR * vpr) : canvasH;
          const color = s.close >= s.open ? 'rgba(38, 166, 154, 0.45)' : 'rgba(239, 83, 80, 0.45)';
          ctx.fillStyle = color;
          ctx.fillRect(x1, yTop, x2 - x1, Math.max(1, yBot - yTop + 1));
        }
      });
    },
  };

  const views = [{ renderer: () => renderer }];

  return {
    attached(param) {
      chart = param.chart;
      series = param.series;
    },
    detached() {
      chart = null;
      series = null;
    },
    paneViews: () => views,
    autoscaleInfo() {
      if (!chart) return null;
      const vr = chart.timeScale().getVisibleRange();
      if (!vr) return null;
      const vf = timeToSeconds(vr.from);
      const vt = timeToSeconds(vr.to);
      if (vf === null || vt === null) return null;
      const wides = getWides();
      let min = Infinity;
      let max = -Infinity;
      for (const s of wides) {
        if (s.end < vf || s.time > vt) continue;
        if (s.volume < min) min = s.volume;
        if (s.volume > max) max = s.volume;
      }
      if (min <= max && max > 0) return { priceRange: { minValue: 0, maxValue: max } };
      return null;
    },
  };
}

function createWideCandlesPrimitive(wides: WideSpan[]): ISeriesPrimitive {
  let chart: PrimParam['chart'] | null = null;
  let series: PrimParam['series'] | null = null;

  const renderer = {
    draw(target: CanvasRenderingTarget2D): void {
      if (!chart || !series) return;
      const ts = chart.timeScale();
      target.useBitmapCoordinateSpace((scope) => {
        const { context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr } = scope;
        const canvasW = ctx.canvas.width;
        const wickW = Math.max(1, Math.round(hpr));
        for (const s of wides) {
          const x1r = ts.timeToCoordinate(s.time as UTCTimestamp);
          if (x1r === null) continue;
          const x2r = Number.isFinite(s.end)
            ? ts.timeToCoordinate(s.end as UTCTimestamp)
            : null;
          const yO = series!.priceToCoordinate(s.open);
          const yC = series!.priceToCoordinate(s.close);
          const yH = series!.priceToCoordinate(s.high);
          const yL = series!.priceToCoordinate(s.low);
          if (yO === null || yC === null || yH === null || yL === null) continue;
          const x1 = Math.round(x1r * hpr);
          const x2 = x2r !== null ? Math.round(x2r * hpr) : canvasW;
          if (x2 <= x1) continue;
          const bx1 = x1;
          const bx2 = x2 - Math.round((x2 - x1) * 0.1);
          if (bx2 <= bx1) continue;
          const color = s.close >= s.open ? '#26a69a' : '#ef5350';
          const cx = (bx1 + bx2) >> 1;
          const yTop = Math.round(Math.min(yO, yC) * vpr);
          const yBot = Math.round(Math.max(yO, yC) * vpr);
          const yHigh = Math.round(yH * vpr);
          const yLow = Math.round(yL * vpr);
          ctx.fillStyle = color;
          ctx.fillRect(cx - (wickW >> 1), yHigh, wickW, Math.max(1, yLow - yHigh + 1));
          ctx.fillRect(bx1, yTop, bx2 - bx1, Math.max(1, yBot - yTop + 1));
        }
      });
    },
  };

  const views = [{ renderer: () => renderer }];

  return {
    attached(param) {
      chart = param.chart;
      series = param.series;
    },
    detached() {
      chart = null;
      series = null;
    },
    paneViews: () => views,
    autoscaleInfo() {
      if (!chart) return null;
      const vr = chart.timeScale().getVisibleRange();
      if (!vr) return null;
      const vf = timeToSeconds(vr.from);
      const vt = timeToSeconds(vr.to);
      if (vf === null || vt === null) return null;
      let min = Infinity;
      let max = -Infinity;
      for (const s of wides) {
        if (s.end < vf || s.time > vt) continue;
        if (s.low < min) min = s.low;
        if (s.high > max) max = s.high;
      }
      if (min <= max) return { priceRange: { minValue: min, maxValue: max } };
      return null;
    },
  };
}

function mergeDetail(base: Candle[], active: DetailSegment[]): Candle[] {
  const detail = new Map<number, Candle>();
  for (const s of active) {
    for (const t of Array.from(detail.keys())) {
      if (t >= s.from && t <= s.to) detail.delete(t);
    }
    for (const c of s.candles) detail.set(c.time, c);
  }
  const merged: Candle[] = [];
  for (const c of base) {
    if (detail.has(c.time)) continue;
    if (active.some((s) => c.time >= s.from && c.time <= s.to)) continue;
    merged.push(c);
  }
  for (const c of detail.values()) merged.push(c);
  merged.sort((a, b) => a.time - b.time);
  return merged;
}

type Props = {
  candles: Candle[];
  segments: DetailSegment[];
  chartType: ChartType;
  selectionMode: boolean;
  selection: Selection | null;
  onSelectRange: (sel: Selection | null) => void;
  onRequestResolution: (from: number, to: number, interval: ResolutionInterval) => void;
  resolutionLoading: boolean;
  resolutionError: string | null;
  newsMarkers: NewsMarker[];
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
  candles: baseCandles,
  segments,
  chartType,
  selectionMode,
  selection,
  onSelectRange,
  onRequestResolution,
  resolutionLoading,
  resolutionError,
  newsMarkers,
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
  const widesRef = useRef<WideSpan[]>([]);
  const selectCallbackRef = useRef(onSelectRange);
  const [hover, setHover] = useState<HoverInfo>(null);
  const [dragLive, setDragLive] = useState<Band | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [coordTick, setCoordTick] = useState(0);

  const activeKey = activeSegmentIndices(segments, baseCandles, chartRef.current).join(',');

  const candles = useMemo(() => {
    if (segments.length === 0) return baseCandles;
    const idx = activeSegmentIndices(segments, baseCandles, chartRef.current);
    if (idx.length === 0) return baseCandles;
    return mergeDetail(baseCandles, idx.map((i) => segments[i]));
  }, [baseCandles, segments, activeKey]);

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
        enableConflation: true,
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
    volumeSeries.attachPrimitive(createWideVolumePrimitive(() => widesRef.current));

    chart.subscribeCrosshairMove((param) => {
      if (!param.time) {
        setHover(null);
        return;
      }
      const t = param.time as number;
      let candle = byTimeRef.current.get(t);
      if (!candle) {
        const snap = nearestTimeRef.current(t);
        if (snap !== null) candle = byTimeRef.current.get(snap);
      }
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
    const prevCandles = prevCandlesRef.current;
    const dataChanged = prevCandles !== candles;
    prevCandlesRef.current = candles;
    const prevRange =
      dataChanged && prevCandles !== null ? chart.timeScale().getVisibleRange() : null;

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
    const padDaily = segments.some((s) => s.interval === 'daily');
    const wides = padDaily ? computeWideSpans(baseCandles, candles) : [];
    widesRef.current = wides;
    const wideTimes = wides.length > 0 ? new Set(wides.map((w) => w.time)) : null;
    const gridTimes = padDaily ? buildDayGridTimes(candles) : null;
    const mapSeriesData = <T,>(make: (c: Candle) => T, hide?: Set<number> | null): (T | WhitespaceData)[] => {
      if (!gridTimes) {
        return candles.map((c) => (hide?.has(c.time) ? { time: c.time as UTCTimestamp } : make(c)));
      }
      const byTime = new Map(candles.map((c) => [c.time, c]));
      return gridTimes.map((t) => {
        const c = byTime.get(t);
        if (!c || hide?.has(c.time)) return { time: t as UTCTimestamp };
        return make(c);
      });
    };

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
      const data = mapSeriesData(
        (c) => ({
          time: c.time as UTCTimestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }),
        wideTimes,
      );
      series.setData(data as never);
      if (wides.length > 0) series.attachPrimitive(createWideCandlesPrimitive(wides));
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
      const data = mapSeriesData((c) => ({
        time: c.time as UTCTimestamp,
        value: c.close,
      }));
      series.setData(data as never);
    }

    seriesRef.current = series;
    volumeRef.current?.setData(
      mapSeriesData(
        (c) => ({
          time: c.time as UTCTimestamp,
          value: c.volume,
          color: c.close >= c.open ? 'rgba(38, 166, 154, 0.45)' : 'rgba(239, 83, 80, 0.45)',
        }),
        wideTimes,
      ) as never,
    );

    if (previous) chart.removeSeries(previous);

    if (dataChanged) {
      if (prevCandles === null) {
        chart.timeScale().fitContent();
        setAnchor(null);
      } else if (prevRange) {
        chart.timeScale().setVisibleRange(prevRange);
      }
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
    const timeOf = (x: number, clamp = true) => {
      const chart = chartRef.current;
      if (!chart) return null;
      const ts = chart.timeScale();
      if (clamp) {
        const range = ts.getVisibleRange();
        if (range) {
          const minX = ts.timeToCoordinate(range.from as UTCTimestamp) ?? 0;
          const maxX = ts.timeToCoordinate(range.to as UTCTimestamp) ?? chart.chartElement().clientWidth;
          x = Math.max(minX, Math.min(maxX, x));
        }
      }
      const t = ts.coordinateToTime(x);
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
      const t = timeOf(x, selectionMode);

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
      if (selectionMode) {
        selectCallbackRef.current({ from, to });
      } else {
        chartRef.current?.timeScale().setVisibleRange({
          from: from as UTCTimestamp,
          to: to as UTCTimestamp,
        });
      }
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

  const chartWidth = chartRef.current?.chartElement().clientWidth ?? 800;
  const newsDots = newsMarkers.map((nm) => {
    const chart = chartRef.current;
    if (!chart) {
      console.log('[news] no chart ref');
      return null;
    }
    const nearest = nearestTimeRef.current(nm.time);
    if (nearest === null) {
      console.log('[news] no nearest time for:', nm.time);
      return null;
    }
    const x = chart.timeScale().timeToCoordinate(nearest as UTCTimestamp);
    if (x === null) {
      console.log('[news] timeToCoordinate returned null for nearest:', nearest);
      return null;
    }
    return { x, news: nm.news, chartWidth };
  }).filter(Boolean) as { x: number; news: NewsItem[]; chartWidth: number }[];
  if (newsDots.length > 0) console.log('[news] rendering dots:', newsDots);

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
          else if (visGran === 'monthly' && spanDays <= 5000) interval = 'daily';
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
        {newsDots.map((dot, idx) => (
          <NewsMarker key={idx} x={dot.x} news={dot.news} chartWidth={dot.chartWidth} />
        ))}
      </div>
    </div>
  );
}

function NewsMarker({ x, news, chartWidth = 800 }: { x: number; news: NewsItem[]; chartWidth?: number }) {
  const [hover, setHover] = useState(false);
  const top = news[0];
  const tooltipRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | undefined>(undefined);

  const tooltipWidth = 300;
  const flipX = x + tooltipWidth / 2 > chartWidth - 16;
  const flipLeft = x - tooltipWidth / 2 < 16;

  const handleMouseEnter = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setHover(true);
  };

  const handleMouseLeave = () => {
    hideTimer.current = setTimeout(() => setHover(false), 150);
  };

  return (
    <div
      className="news-marker-wrapper"
      style={{ left: x }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="news-dot-marker" />
      {hover && top && (
        <div
          ref={tooltipRef}
          className="news-dot-tooltip"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          style={{
            left: flipLeft ? 0 : flipX ? 'auto' : '50%',
            right: flipX ? 0 : 'auto',
            transform: flipX || flipLeft ? 'none' : 'translateX(-50%)',
            animation: flipX || flipLeft ? 'fadeIn 0.15s ease-out' : 'none',
          }}
        >
          <a
            className="news-link"
            href={`https://www.google.com/search?q=${encodeURIComponent(top.title)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="news-source">{top.source || 'News'}</span>
            <span className="news-title">{top.title}</span>
            <span className="news-date">{top.date}</span>
          </a>
        </div>
      )}
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
