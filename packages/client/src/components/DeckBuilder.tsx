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
import { CardDb, checkTokuiWaza, MAX_DECK_SIZE, MAX_MP_LEVEL, MIN_DECK_SIZE, validateDeck, type EngineCard } from '@dbz/engine';
import { CardDetail } from './CardDetail.tsx';

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

/**
 * Personality stacks available as a Main Personality, keyed by CHARACTER.
 *
 * Levels are drawn across sets, not within one: plenty of personalities did not
 * get a level 3, 4 or 5 until a later release, so a Goku stack is routinely
 * built from cards printed years apart. Grouping by character + saga hid all of
 * those — a character whose Lv1-2 shipped in one set and Lv3 in another simply
 * never reached three levels and never appeared.
 *
 * Three consecutive levels from 1 is the floor (CRD ~L64), so a character
 * without a level 3 cannot be a Main Personality at all.
 */
const MIN_MP_LEVELS_FOR_STACK = 3;

export interface MpOption {
  key: string;
  name: string;
  saga: string;
  /** Every printing of every level, so the player can choose each one. */
  byLevel: Map<number, EngineCard[]>;
  /** Highest level reachable with no gaps from 1. */
  maxLevel: number;
}

function mpOptions(cards: EngineCard[]): MpOption[] {
  const groups = new Map<string, EngineCard[]>();
  for (const c of cards) {
    const p = c.rules?.personality;
    if (!p?.personalityName || !p.level) continue;
    groups.set(p.personalityName, [...(groups.get(p.personalityName) ?? []), c]);
  }
  const out: MpOption[] = [];
  for (const [name, list] of groups) {
    // Keep EVERY printing of each level. Goku has nine different level 1s and
    // six level 3s, with different power ratings and different powers, so
    // picking one for the player is picking their deck for them.
    const byLevel = new Map<number, EngineCard[]>();
    for (const c of list) {
      const lv = c.rules!.personality!.level!;
      byLevel.set(lv, [...(byLevel.get(lv) ?? []), c]);
    }
    for (const [, printings] of byLevel) printings.sort((a, b) => a.name.localeCompare(b.name) || a.saga.localeCompare(b.saga));

    let maxLevel = 0;
    while (byLevel.has(maxLevel + 1)) maxLevel++;
    if (maxLevel < MIN_MP_LEVELS_FOR_STACK) continue;

    const sagas = [...new Set(list.map((c) => c.saga))];
    out.push({ key: name, name, byLevel, maxLevel, saga: sagas.length > 1 ? `${sagas.length} sets` : sagas[0] ?? '' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** A short, distinguishing label for one printing of a level. */
function printingLabel(c: EngineCard): string {
  const ladder = c.rules?.personality?.powerRatings ?? [];
  const top = ladder.length ? ladder[ladder.length - 1] : undefined;
  const pur = c.rules?.personality?.pur;
  const bits = [c.saga];
  if (top !== undefined) bits.push(`top ${typeof top === 'number' ? top.toLocaleString() : top}`);
  if (pur) bits.push(`PUR ${pur}`);
  return `${c.name} — ${bits.join(' · ')}`;
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
  /** Chosen printing per level — several exist for most levels. */
  mpPicks?: Record<number, string>;
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
      ...(d.mpPicks && typeof d.mpPicks === 'object' ? { mpPicks: d.mpPicks } : {}),
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
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [mpPicks, setMpPicks] = useState<Record<number, string>>(saved?.mpPicks ?? {});
  const [preview, setPreview] = useState<EngineCard | null>(null);

  const mps = useMemo(() => mpOptions(cards), [cards]);
  const mp = mps.find((m) => m.key === mpKey);
  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);

  /** The chosen printing for each level, defaulting to the first available. */
  const chosenLevels = useMemo(() => {
    if (!mp) return [] as EngineCard[];
    const out: EngineCard[] = [];
    for (let lv = 1; lv <= Math.min(mpDepth, mp.maxLevel); lv++) {
      const printings = mp.byLevel.get(lv) ?? [];
      const picked = printings.find((c) => c.id === mpPicks[lv]) ?? printings[0];
      if (picked) out.push(picked);
    }
    return out;
  }, [mp, mpDepth, mpPicks]);

  const deck: DeckList = useMemo(
    () => ({
      name: deckName,
      mpLevels: chosenLevels.map((c) => c.id),
      ...(masteryId ? { masteryId } : {}),
      life: lines.filter((l) => l.qty > 0),
    }),
    [deckName, chosenLevels, masteryId, lines],
  );

  // Persist on every change: the deck survives a refresh, a crash, or coming
  // back tomorrow. Storage can throw (private mode, quota) and a lost deck is
  // not worth breaking the builder over.
  useEffect(() => {
    try {
      localStorage.setItem(SAVED_DECK_KEY, JSON.stringify({ deckName, mpKey, mpDepth, masteryId, lines, mpPicks }));
    } catch {
      /* not fatal */
    }
  }, [deckName, mpKey, mpDepth, masteryId, lines, mpPicks]);

  const lifeCount = lines.reduce((n, l) => n + l.qty, 0);
  const total = deck.mpLevels.length + lifeCount + (masteryId ? 1 : 0);
  const errors = useMemo(() => (db ? validateDeck(deck, db) : ['catalog still loading']), [deck, db]);
  const legal = errors.length === 0;

  /** Recognisable faces first — the point is that a newcomer sees a name they know. */
  const starters = useMemo(() => {
    const wanted = ['Goku', 'Vegeta', 'Piccolo', 'Gohan', 'Krillin', 'Nappa'];
    const picked = wanted.map((n) => mps.find((m) => m.name === n)).filter((m): m is (typeof mps)[number] => !!m);
    return picked.length > 0 ? picked : mps.slice(0, 6);
  }, [mps]);

  const masteries = useMemo(() => cards.filter((c) => c.rules?.type === 'Mastery'), [cards]);
  /** Live Tokui-Waza read-out: declaring one is what grants +1 PUR. */
  const tokui = useMemo(() => {
    if (!db || !masteryId) return null;
    const all = [...deck.mpLevels, ...deck.life.map((l) => l.cardId)];
    return checkTokuiWaza(masteryId, all, db);
  }, [db, masteryId, deck]);

  /** Types actually present in the pool, most common first. */
  const poolTypes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of cards) {
      if (c.rules?.personality) continue;
      const t = c.rules?.type ?? 'Unknown';
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [cards]);

  const pool = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const matches = cards
      .filter((c) => !c.rules?.personality)
      .filter((c) => typeFilter === 'all' || (c.rules?.type ?? 'Unknown') === typeFilter)
      .filter((c) => !needle || c.name.toLowerCase().includes(needle) || (c.rules?.text ?? '').toLowerCase().includes(needle));
    // Say how many were cut, rather than silently showing the first 120 and
    // letting someone conclude the card they want is not in the game.
    return { shown: matches.slice(0, 120), total: matches.length };
  }, [cards, q, typeFilter]);

  const bump = (cardId: string, delta: number) =>
    setLines((prev) => {
      const at = prev.findIndex((l) => l.cardId === cardId);
      if (at === -1) return delta > 0 ? [...prev, { cardId, qty: delta }] : prev;
      const qty = prev[at]!.qty + delta;
      if (qty <= 0) return prev.filter((l) => l.cardId !== cardId);
      return prev.map((l, i) => (i === at ? { ...l, qty } : l));
    });

  /**
   * Build a complete, legal deck for one personality from nothing.
   *
   * The people this game is for should not have to learn deck construction to
   * take a seat. Landing in a 2,764-card builder needing 50+ legal cards is the
   * point where a friend gives up, so "play as Goku" has to be one button.
   */
  /** The default printing of levels 1-3, which is what a starter deck uses. */
  const firstThreeLevels = (choice: MpOption): EngineCard[] =>
    Array.from({ length: MIN_MP_LEVELS_FOR_STACK }, (_, i) => choice.byLevel.get(i + 1)?.[0]).filter(
      (c): c is EngineCard => !!c,
    );

  const starterFor = (choice: MpOption): { lines: Line[]; name: string } => {
    const chosen = new Map<string, number>();
    let need = MIN_DECK_SIZE - MIN_MP_LEVELS_FOR_STACK;
    for (const c of cards) {
      if (need <= 0) break;
      if (c.rules?.personality) continue;
      if (/dragon ball/i.test(c.rules?.type ?? '')) continue;
      if (c.name.toLowerCase().includes(choice.name.toLowerCase())) continue; // named-card limits
      if (c.style) continue; // Freestyle only: no Mastery, so no style to match
      const printed = /limit\s*(\d+)\s*per\s*deck/i.exec(c.rules?.text ?? '');
      const cap = printed ? Math.min(3, Number(printed[1])) : 3;
      const add = Math.min(cap, need);
      if (add <= 0) continue;
      chosen.set(c.id, add);
      need -= add;
    }
    return { lines: [...chosen.entries()].map(([cardId, qty]) => ({ cardId, qty })), name: `${choice.name} starter` };
  };

  const playAs = (choice: MpOption) => {
    const built = starterFor(choice);
    setMpKey(choice.key);
    setMpDepth(3);
    setMasteryId('');
    setLines(built.lines);
    setDeckName(built.name);
    onSubmit({
      name: built.name,
      mpLevels: firstThreeLevels(choice).map((c) => c.id),
      life: built.lines,
    });
  };

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
      <section className="builder__quick">
        <h2>New here? Pick a character</h2>
        <p>One click builds you a legal deck. You can change any of it below.</p>
        <div className="builder__quickrow">
          {starters.map((s) => (
            <button key={s.key} onClick={() => playAs(s)}>
              {s.name}
              <em>{s.saga}</em>
            </button>
          ))}
        </div>
      </section>

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
                {m.name} [{m.saga}] · {m.maxLevel} levels
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
              max={Math.min(MAX_MP_LEVEL, mp.maxLevel)}
              value={mpDepth}
              onChange={(e) => setMpDepth(Number(e.target.value))}
            />
          </label>
        )}

        {mp && (
          <div className="builder__levels">
            {/* Each level usually has several printings with different power
                ratings and different powers — Goku has nine level 1s — so the
                player chooses each one rather than getting whichever happened
                to be first in the catalog. */}
            {chosenLevels.map((card, i) => {
              const lv = i + 1;
              const printings = mp.byLevel.get(lv) ?? [];
              return (
                <label key={lv}>
                  Level {lv}
                  {printings.length > 1 && <em> · {printings.length} printings</em>}
                  <div className="builder__levelrow">
                    <select value={card.id} onChange={(e) => setMpPicks((p) => ({ ...p, [lv]: e.target.value }))}>
                      {printings.map((c) => (
                        <option key={c.id} value={c.id}>
                          {printingLabel(c)}
                        </option>
                      ))}
                    </select>
                    <button className="ghost" onClick={() => setPreview(card)} title={`Enlarge ${card.name}`}>
                      View
                    </button>
                  </div>
                </label>
              );
            })}
          </div>
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

        <div className="builder__types">
          <button className={typeFilter === 'all' ? 'on' : ''} onClick={() => setTypeFilter('all')}>
            All
          </button>
          {poolTypes.map(([t, n]) => (
            <button key={t} className={typeFilter === t ? 'on' : ''} onClick={() => setTypeFilter(t)}>
              {t} <em>{n}</em>
            </button>
          ))}
        </div>

        <p className="builder__count muted">
          {pool.total} card{pool.total === 1 ? '' : 's'}
          {pool.total > pool.shown.length && ` — showing the first ${pool.shown.length}, narrow the search to see more`}
        </p>

        <ul>
          {pool.shown.map((c) => (
            <li key={c.id}>
              {/* The art is the readable copy of the card, so make it openable:
                  deck building means reading effects, and the one-line summary
                  underneath is not enough to choose between two similar cards. */}
              <button className="builder__thumb" onClick={() => setPreview(c)} title={`Enlarge ${c.name}`}>
                <img
                  src={`/cards/${c.id}.jpg`}
                  alt=""
                  loading="lazy"
                  onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')}
                />
              </button>
              <div>
                <button className="builder__name" onClick={() => setPreview(c)}>
                  {c.name}
                </button>
                <span className="muted">
                  {c.saga} · {c.rules?.type ?? 'Unknown'}
                </span>
              </div>
              <button onClick={() => bump(c.id, +1)}>Add</button>
            </li>
          ))}
        </ul>
      </section>

      {preview && (
        <div className="builder__preview" onClick={() => setPreview(null)}>
          <CardDetail
            card={preview}
            onClose={() => setPreview(null)}
            actions={[{ label: 'Add to deck', run: () => bump(preview.id, +1) }]}
          />
        </div>
      )}
    </main>
  );
}
