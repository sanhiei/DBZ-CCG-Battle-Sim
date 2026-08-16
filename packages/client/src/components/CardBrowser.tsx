/**
 * Card browser — searchable catalog with coverage badges.
 *
 * Coverage is surfaced deliberately: players should be able to see which cards
 * the engine can resolve end-to-end and which still need manual handling.
 */
import { useMemo, useState } from 'react';
import type { EngineCard } from '@dbz/engine';

const COVERAGE_ORDER = ['full', 'partial', 'metadata', 'unknown'] as const;

export function CardBrowser({ cards }: { cards: EngineCard[] }) {
  const [q, setQ] = useState('');
  const [saga, setSaga] = useState('');
  const [coverage, setCoverage] = useState('');

  const sagas = useMemo(() => [...new Set(cards.map((c) => c.saga))].sort(), [cards]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return cards
      .filter((c) => {
        if (saga && c.saga !== saga) return false;
        if (coverage && (c.rules?.coverage ?? 'unknown') !== coverage) return false;
        if (!needle) return true;
        return c.name.toLowerCase().includes(needle) || (c.rules?.text ?? '').toLowerCase().includes(needle);
      })
      .slice(0, 300);
  }, [cards, q, saga, coverage]);

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const c of cards) {
      const k = c.rules?.coverage ?? 'unknown';
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  }, [cards]);

  return (
    <main className="browser">
      <div className="browser__filters">
        <input placeholder="Search name or rules text…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={saga} onChange={(e) => setSaga(e.target.value)}>
          <option value="">All sagas</option>
          {sagas.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select value={coverage} onChange={(e) => setCoverage(e.target.value)}>
          <option value="">Any coverage</option>
          {COVERAGE_ORDER.map((c) => (
            <option key={c} value={c}>
              {c} ({counts[c] ?? 0})
            </option>
          ))}
        </select>
        <span className="browser__count">{shown.length} shown</span>
      </div>

      <ul className="browser__grid">
        {shown.map((c) => {
          const cov = c.rules?.coverage ?? 'unknown';
          return (
            <li key={c.id} className="card">
              <img src={`/cards/${c.id}.jpg`} alt={c.name} loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')} />
              <div className="card__meta">
                <strong>{c.name}</strong>
                <span className={`cov cov--${cov}`}>{cov}</span>
                <span className="card__saga">{c.saga}</span>
                {c.rules?.type && <span className="card__type">{c.rules.type}</span>}
                {c.rules?.text && <p className="card__text">{c.rules.text}</p>}
              </div>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
