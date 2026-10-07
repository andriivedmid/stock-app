import { useEffect, useRef, useState } from 'react';
import { searchSymbols, type Quote } from './api';

type Props = {
  onSelect: (quote: Quote) => void;
  selected?: Quote | null;
};

export function SearchBar({ onSelect, selected }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Quote[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setResults([]);
      setOpen(false);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await searchSymbols(trimmed);
        if (controller.signal.aborted) return;
        setResults(res.quotes);
        setActive(0);
        setOpen(true);
      } catch {
        if (!controller.signal.aborted) setResults([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => {
    const onClickAway = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickAway);
    return () => document.removeEventListener('mousedown', onClickAway);
  }, []);

  const pick = (quote: Quote) => {
    onSelect(quote);
    setQuery('');
    setResults([]);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
      setOpen(true);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && results[active]) pick(results[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="search" ref={boxRef}>
      <svg className="search-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path
          fill="currentColor"
          d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"
        />
      </svg>
      <input
        className="search-input"
        type="text"
        placeholder="Search stocks, e.g. AAPL, Apple, Tesla…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => results.length > 0 && setOpen(true)}
        aria-label="Search for a stock symbol"
      />
      {loading && <span className="search-spinner" aria-hidden="true" />}
      {open && results.length > 0 && (
        <ul className="search-results" role="listbox">
          {results.map((q, i) => (
            <li
              key={q.symbol}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(q);
              }}
            >
              <span className="result-symbol">{q.symbol}</span>
              <span className="result-name">{q.name}</span>
              <span className="result-type">{q.type}</span>
            </li>
          ))}
        </ul>
      )}
      {open && query.trim() && !loading && results.length === 0 && (
        <div className="search-empty">No matches found</div>
      )}
      {selected && !query && <span className="search-current">{selected.symbol}</span>}
    </div>
  );
}
