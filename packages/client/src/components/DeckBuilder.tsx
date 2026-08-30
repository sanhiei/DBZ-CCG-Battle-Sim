/**
 * Deck builder — build a legal Life Deck and submit it to the room.
 *
 * Legality is checked with the SAME `validateDeck` the server enforces (it
 * lives in the engine precisely so both sides share it), so the errors shown
 * here are exactly the ones that would come back from a rejected submission.
 * The build is still re-validated server-side; this is convenience, not trust.
 */
import { useEffect, useMemo, useState } from 'react';
import type { DeckList } from '@dbz/shared';
import { CardDb, checkTokuiWaza, MAX_DECK_SIZE, MIN_DECK_SIZE, validateDeck, type EngineCard } from '@dbz/engine';

export interface DeckBuilderProps {
  cards: EngineCard[];
  db: CardDb | null;
  seat: number | null;
  onSubmit(deck: DeckList): void;
  onReady(): void;
  submittedName?: string;
  ready: boolean;
}

interface Line {
  cardId: string;
  qty: number;
}

/** Personality stacks available as a Main Personality, keyed by name + saga. */
function mpOptions(cards: EngineCard[]): Array<{ key: string; name: string; saga: string; levels: EngineCard[] }> {
  const groups = new Map<string, EngineCard[]>();
  for (const c of cards) {
    const p = c.rules?.personality;
    if (!p?.personalityName || !p.level) continue;
    const key = `${p.personalityName}|${c.saga}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const out: Array<{ key: string; name: string; saga: string; levels: EngineCard[] }> = [];
  for (const [key, list] of groups) {
    // Need levels 1..N consecutive, one card per level.
    const byLevel = new Map<number, EngineCard>();
    for (const c of list) {
      const lv = c.rules!.personality!.level!;
      if (!byLevel.has(lv)) byLevel.set(lv, c);
    }
    const levels: EngineCard[] = [];
    for (let lv = 1; byLevel.has(lv); lv++) levels.push(byLevel.get(lv)!);
    if (levels.length >= 3) {
      const [name, saga] = key.split('|');
      out.push({ key, name: name!, saga: saga!, levels });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.saga.localeCompare(b.saga));
}

/**
 * The builder's selections, kept in the browser.
 *
 * A legal deck is 50+ cards and takes real time to assemble. Everything here
 * lived in component state, so a refresh — or just closing the tab between
 * games — threw the whole deck away and you started from an empty list. Nobody
 * builds that twice.
 *
 * Only the selections are stored, not the resolved deck: card ids are
 * revalidated against the catalog on load, so a stored deck cannot smuggle in
 * cards that no longer exist. The server revalidates regardless.
 */
const SAVED_DECK_KEY = 'dbz.deck.v1';

interface SavedDeck {
  deckName: string;
  mpKey: string;
  mpDepth: number;
  masteryId: string;
  lines: Line[];
}

function loadSavedDeck(): SavedDeck | null {
  try {
    const raw = localStorage.getItem(SAVED_DECK_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<SavedDeck>;
    if (typeof d?.deckName !== 'string' || !Array.isArray(d.lines)) return null;
    return {
      deckName: d.deckName,
      mpKey: typeof d.mpKey === 'string' ? d.mpKey : '',
      mpDepth: Number.isInteger(d.mpDepth) ? (d.mpDepth as number) : 3,
      masteryId: typeof d.masteryId === 'string' ? d.masteryId : '',
      lines: d.lines.filter((l): l is Line => !!l && typeof l.cardId === 'string' && Number.isInteger(l.qty)),
    };
  } catch {
    return null; // private mode, cleared storage, or hand-edited junk
  }
}

export function DeckBuilder({ cards, db, seat, onSubmit, onReady, submittedName, ready }: DeckBuilderProps) {
  const saved = useMemo(() => loadSavedDeck(), []);
  const [deckName, setDeckName] = useState(saved?.deckName ?? 'My Deck');
  const [mpKey, setMpKey] = useState(saved?.mpKey ?? '');
  const [mpDepth, setMpDepth] = useState(saved?.mpDepth ?? 3);
  const [masteryId, setMasteryId] = useState(saved?.masteryId ?? '');
  const [lines, setLines] = useState<Line[]>(saved?.lines ?? []);
  const [q, setQ] = useState('');

  const mps = useMemo(() => mpOptions(cards), [cards]);
  const mp = mps.find((m) => m.key === mpKey);
  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);

  const deck: DeckList = useMemo(
    () => ({
      name: deckName,
      mpLevels: mp ? mp.levels.slice(0, mpDepth).map((c) => c.id) : [],
      ...(masteryId ? { masteryId } : {}),
      life: lines.filter((l) => l.qty > 0),
    }),
    [deckName, mp, mpDepth, masteryId, lines],
  );

  // Persist on every change: the deck survives a refresh, a crash, or coming
  // back tomorrow. Storage can throw (private mode, quota) and a lost deck is
  // not worth breaking the builder over.
  useEffect(() => {
    try {
      localStorage.setItem(SAVED_DECK_KEY, JSON.stringify({ deckName, mpKey, mpDepth, masteryId, lines }));
    } catch {
      /* not fatal */
    }
  }, [deckName, mpKey, mpDepth, masteryId, lines]);

  const lifeCount = lines.reduce((n, l) => n + l.qty, 0);
  const total = deck.mpLevels.length + lifeCount + (masteryId ? 1 : 0);
  const errors = useMemo(() => (db ? validateDeck(deck, db) : ['catalog still loading']), [deck, db]);
  const legal = errors.length === 0;

  const masteries = useMemo(() => cards.filter((c) => c.rules?.type === 'Mastery'), [cards]);
  /** Live Tokui-Waza read-out: declaring one is what grants +1 PUR. */
  const tokui = useMemo(() => {
    if (!db || !masteryId) return null;
    const all = [...deck.mpLevels, ...deck.life.map((l) => l.cardId)];
    return checkTokuiWaza(masteryId, all, db);
  }, [db, masteryId, deck]);

  const pool = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return cards
      .filter((c) => !c.rules?.personality)
      .filter((c) => !needle || c.name.toLowerCase().includes(needle) || (c.rules?.text ?? '').toLowerCase().includes(needle))
      .slice(0, 120);
  }, [cards, q]);

  const bump = (cardId: string, delta: number) =>
    setLines((prev) => {
      const at = prev.findIndex((l) => l.cardId === cardId);
      if (at === -1) return delta > 0 ? [...prev, { cardId, qty: delta }] : prev;
      const qty = prev[at]!.qty + delta;
      if (qty <= 0) return prev.filter((l) => l.cardId !== cardId);
      return prev.map((l, i) => (i === at ? { ...l, qty } : l));
    });

  /** Fill to the minimum with legal copies, so a playable deck is one click away. */
  const autoFill = () => {
    if (!mp) return;
    const chosen = new Map(lines.map((l) => [l.cardId, l.qty]));
    let need = MIN_DECK_SIZE - deck.mpLevels.length - lifeCount - (masteryId ? 1 : 0);
    for (const c of cards) {
      if (need <= 0) break;
      if (c.rules?.personality) continue;
      if (/dragon ball/i.test(c.name)) continue; // limit 1 each; skip for the quick fill
      if (c.name.toLowerCase().includes(mp.name.toLowerCase())) continue; // named-card limits
      // Respect the declared Tokui-Waza: off-style cards would make it illegal.
      if (masteryId && db) {
        const mStyle = db.get(masteryId)?.style ?? null;
        if (c.style && c.style !== mStyle) continue;
      }
      // Respect a printed "Limit N per deck" (CRD ~L51). Assuming 3 of
      // everything now builds a deck the server rejects, since 168 cards say
      // otherwise — and the quick fill exists precisely so you do not have to
      // know that.
      const printed = /limit\s*(\d+)\s*per\s*deck/i.exec(c.rules?.text ?? '');
      const cap = printed ? Math.min(3, Number(printed[1])) : 3;
      const have = chosen.get(c.id) ?? 0;
      const add = Math.min(cap - have, need);
      if (add <= 0) continue;
      chosen.set(c.id, have + add);
      need -= add;
    }
    setLines([...chosen.entries()].map(([cardId, qty]) => ({ cardId, qty })));
  };

  if (seat === null) {
    return <main className="builder"><p>Spectators cannot submit a deck.</p></main>;
  }

  return (
    <main className="builder">
      <section className="builder__config">
        <h2>Deck</h2>
        <label>
          Name
          <input value={deckName} onChange={(e) => setDeckName(e.target.value)} maxLength={60} />
        </label>
        <label>
          Main Personality
          <select value={mpKey} onChange={(e) => setMpKey(e.target.value)}>
            <option value="">— choose —</option>
            {mps.map((m) => (
              <option key={m.key} value={m.key}>
                {m.name} [{m.saga}] · {m.levels.length} levels
              </option>
            ))}
          </select>
        </label>
        <label>
          Mastery (optional — declares a Tokui-Waza, +1 PUR)
          <select value={masteryId} onChange={(e) => setMasteryId(e.target.value)}>
            <option value="">— none —</option>
            {masteries.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} [{m.saga}]{m.style ? ` · ${m.style}` : ' · Freestyle'}
              </option>
            ))}
          </select>
        </label>
        {tokui && (
          <p className={tokui.errors.length ? 'tokui tokui--bad' : 'tokui tokui--ok'}>
            {tokui.errors.length
              ? `Tokui-Waza illegal: ${tokui.errors[0]}`
              : `${tokui.style ?? 'Freestyle'} Tokui-Waza declared — Main Personality gains +1 PUR.`}
          </p>
        )}
        {mp && (
          <label>
            Levels ({mpDepth})
            <input
              type="range"
              min={3}
              max={Math.min(5, mp.levels.length)}
              value={mpDepth}
              onChange={(e) => setMpDepth(Number(e.target.value))}
            />
          </label>
        )}

        <div className="builder__counts">
          <span className={total < MIN_DECK_SIZE || total > MAX_DECK_SIZE ? 'bad' : 'good'}>
            {total} cards
          </span>
          <span className="muted">
            min {MIN_DECK_SIZE} · max {MAX_DECK_SIZE}
          </span>
          <button onClick={autoFill} disabled={!mp}>
            Auto-fill to {MIN_DECK_SIZE}
          </button>
          <button className="ghost" onClick={() => setLines([])}>
            Clear
          </button>
        </div>

        <ul className="builder__errors">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
          {legal && <li className="ok">Legal deck.</li>}
        </ul>

        <div className="builder__submit">
          <button disabled={!legal} onClick={() => onSubmit(deck)}>
            Submit deck
          </button>
          <button disabled={!submittedName || ready} onClick={onReady}>
            {ready ? 'Ready ✓' : 'Ready up'}
          </button>
          {submittedName && <span className="muted">submitted: {submittedName}</span>}
        </div>

        <h3>Life Deck ({lifeCount})</h3>
        <ul className="builder__lines">
          {lines.map((l) => (
            <li key={l.cardId}>
              <button onClick={() => bump(l.cardId, -1)}>−</button>
              <span className="qty">{l.qty}</span>
              <button onClick={() => bump(l.cardId, +1)}>+</button>
              <span className="nm">{byId.get(l.cardId)?.name ?? l.cardId}</span>
            </li>
          ))}
          {lines.length === 0 && <li className="muted">No cards yet — search on the right, or auto-fill.</li>}
        </ul>
      </section>

      <section className="builder__pool">
        <input placeholder="Search the catalog…" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul>
          {pool.map((c) => (
            <li key={c.id}>
              <img src={`/cards/${c.id}.jpg`} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')} />
              <div>
                <strong>{c.name}</strong>
                <span className="muted">
                  {c.saga} · {c.rules?.type ?? 'Unknown'}
                </span>
              </div>
              <button onClick={() => bump(c.id, +1)}>Add</button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
