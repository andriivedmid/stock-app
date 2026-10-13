import { useEffect, useMemo, useRef, useState } from 'react';

type Props = {
  value: string;
  min?: string;
  max?: string;
  disabled?: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
};

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function toDate(iso: string | undefined): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function toISO(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function DatePicker({ value, min, max, disabled, placeholder, onChange }: Props) {
  const [monthAnchor, setMonthAnchor] = useState<Date>(() => {
    const sel = toDate(value);
    return sel ?? new Date();
  });
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const minDate = useMemo(() => toDate(min), [min]);
  const maxDate = useMemo(() => toDate(max), [max]);
  const selected = toDate(value);
  const today = new Date();

  useEffect(() => {
    if (selected) setMonthAnchor(new Date(selected.getFullYear(), selected.getMonth(), 1));
  }, [value, selected]);

  useEffect(() => {
    const onClickAway = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClickAway);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClickAway);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const year = monthAnchor.getFullYear();
  const month = monthAnchor.getMonth();

  const cells: (Date | null)[] = useMemo(() => {
    const first = new Date(year, month, 1);
    const lead = first.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const list: (Date | null)[] = Array.from({ length: lead }, () => null);
    for (let d = 1; d <= daysInMonth; d++) list.push(new Date(year, month, d));
    return list;
  }, [year, month]);

  const prevDisabled = useMemo(() => {
    if (!minDate) return false;
    const first = new Date(year, month, 1);
    return first.getTime() <= minDate.getTime() && month <= minDate.getMonth() && year <= minDate.getFullYear();
  }, [monthAnchor, minDate]);

  const nextDisabled = useMemo(() => {
    if (!maxDate) return false;
    return new Date(year, month + 1, 1).getTime() > maxDate.getTime();
  }, [monthAnchor, maxDate]);

  const isHidden = (d: Date): boolean =>
    (minDate ? d.getTime() < minDate.getTime() : false) ||
    (maxDate ? d.getTime() > maxDate.getTime() : false);

  const pick = (d: Date) => {
    onChange(toISO(d));
    setOpen(false);
  };

  return (
    <div className="date-picker" ref={boxRef}>
      <button
        type="button"
        className="date-picker-trigger"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        title="Pick an end date, then press Load to rechart the graph"
      >
        <svg className="date-picker-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path
            fill="currentColor"
            d="M7 2a1 1 0 0 1 1 1v1h8V3a1 1 0 1 1 2 0v1h1a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1V3a1 1 0 0 1 1-1zm-2 6v11h14V8H5zm4 3a1 1 0 1 1 0 2h6a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2z"
          />
        </svg>
        <span className={`date-picker-text ${value ? '' : 'empty'}`}>
          {value
            ? toDate(value)?.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
            : (placeholder ?? 'Any date')}
        </span>
      </button>

      {open && !disabled && (
        <div className="date-picker-popover">
          <div className="date-picker-header">
            <button
              type="button"
              className="date-picker-nav"
              disabled={prevDisabled}
              onClick={() => setMonthAnchor(new Date(year, month - 1, 1))}
              aria-label="Previous month"
            >
              ‹
            </button>
            <span className="date-picker-month">
              {MONTHS[month]} {year}
            </span>
            <button
              type="button"
              className="date-picker-nav"
              disabled={nextDisabled}
              onClick={() => setMonthAnchor(new Date(year, month + 1, 1))}
              aria-label="Next month"
            >
              ›
            </button>
          </div>
          <div className="date-picker-grid" role="grid">
            {WEEKDAYS.map((wd, i) => (
              <span key={i} className="date-picker-weekday">{wd}</span>
            ))}
            {cells.map((d, i) => {
              if (!d) return <span key={i} />;
              const hidden = isHidden(d);
              const isSel = selected ? sameDay(d, selected) : false;
              const isToday = sameDay(d, today);
              const cls = [
                'date-picker-day',
                hidden ? 'disabled' : '',
                isSel ? 'selected' : '',
                isToday ? 'today' : '',
              ].join(' ').trim();
              return (
                <button
                  key={i}
                  type="button"
                  className={cls}
                  disabled={hidden}
                  onClick={() => pick(d)}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}