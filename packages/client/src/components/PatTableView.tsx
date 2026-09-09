/**
 * The Physical Attack Table, on screen.
 *
 * Physical Base Damage is a lookup: find the attacker's power rating bracket,
 * find the defender's, read the cell. At a real table the PAT is a card sitting
 * face up that both players read all game — here the engine did the lookup
 * silently and there was no way to see the grid, so the single most important
 * number in combat arrived unexplained.
 *
 * If the host has a scan of the printed card (data/pat-images/, gitignored the
 * same way the card faces are) that is what you get, because it is the real
 * thing and players already know how to read it. Without one, the same grid is
 * drawn from the table data — a fresh clone with no art still shows the numbers.
 *
 * Either way the live lookup is spelled out underneath: an image cannot
 * highlight a cell, and "why did that hit for 3?" is the question this is
 * actually here to answer.
 */
import { useEffect, useState } from 'react';
import type { PatTable } from '@dbz/engine';

export interface PatTableViewProps {
  table: PatTable | null;
  /** Power rating of the personality attacking right now, if any. */
  attackerRating?: number | undefined;
  /** Power rating of the personality being attacked right now, if any. */
  defenderRating?: number | undefined;
  onClose(): void;
}

const CARD_IMAGE = '/pat-image/default';

/** Which bracket a rating falls in, clamped at both ends like the engine does. */
function bracketIndex(table: PatTable, rating: number | undefined): number | null {
  if (rating === undefined) return null;
  const at = table.brackets.findIndex((b) => rating >= b.minRating && rating <= b.maxRating);
  if (at !== -1) return at;
  return rating < (table.brackets[0]?.minRating ?? 0) ? 0 : table.brackets.length - 1;
}

const short = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
};

/** Whether the host actually has a scan, asked before rendering a broken image. */
function useCardScan(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let alive = true;
    const img = new Image();
    img.onload = () => alive && setOk(true);
    img.onerror = () => alive && setOk(false);
    img.src = CARD_IMAGE;
    return () => {
      alive = false;
    };
  }, []);
  return ok;
}

export function PatTableView({ table, attackerRating, defenderRating, onClose }: PatTableViewProps) {
  const hasScan = useCardScan();
  if (!table) return null;
  const atk = bracketIndex(table, attackerRating);
  const def = bracketIndex(table, defenderRating);
  const live = atk !== null && def !== null;
  const result = live ? table.damage[atk]?.[def] ?? 0 : null;

  return (
    <div className="pat" role="dialog" aria-label="Physical Attack Table">
      <button className="detail__close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <h3>Physical Attack Table</h3>

      {live && (
        <p className="pat__live">
          This attack: <b>{table.brackets[atk]!.letter}</b> vs <b>{table.brackets[def]!.letter}</b> ={' '}
          <b>{result}</b> power stage{result === 1 ? '' : 's'}
        </p>
      )}

      {hasScan ? (
        <img className="pat__scan" src={CARD_IMAGE} alt="Physical Attack Table" />
      ) : (
        <>
          <p className="muted pat__blurb">
            Attacker down the side, defender across the top. The cell is the Base Damage in power
            stages. A <b>Z</b> rating always deals {table.special.zResult}.
          </p>
          {table.placeholder && (
            <p className="pat__warn">
              These are placeholder values, not the printed table — combat numbers will be wrong.
            </p>
          )}
          <div className="pat__scroll">
            <table className="pat__grid">
              <thead>
                <tr>
                  <th />
                  {table.brackets.map((b, i) => (
                    <th
                      key={b.letter}
                      className={i === def ? 'is-live' : ''}
                      title={`${short(b.minRating)}–${short(b.maxRating)}`}
                    >
                      {b.letter}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.brackets.map((row, r) => (
                  <tr key={row.letter} className={r === atk ? 'is-live' : ''}>
                    <th title={`${short(row.minRating)}–${short(row.maxRating)}`}>{row.letter}</th>
                    {table.brackets.map((_col, c) => (
                      <td key={c} className={r === atk && c === def ? 'is-hit' : c === def ? 'is-live' : ''}>
                        {table.damage[r]?.[c] ?? 0}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="pat__legend">
            {table.brackets.map((b) => (
              <li key={b.letter}>
                <b>{b.letter}</b> {short(b.minRating)}–{short(b.maxRating)}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
