# Architecture

## Decisions (locked)
- **Full rules engine** (not just a state tracker), **online multiplayer**, **scraped card data**.
- **TypeScript end-to-end**, npm workspaces monorepo.
- **Authoritative server + shared reducer.** The engine is a pure `(state, action) -> {state, events}` reducer. The server runs it authoritatively; clients run the same reducer for **optimistic** local prediction and reconcile on the server's broadcast. (This mirrors the inspiration app, which shipped one shared reducer to both sides.)

## Data flow
```
client action ──ws──▶ server: validate + engine.reduce ──▶ authoritative state
       │  (optimistic local reduce)                             │
       └────────────────◀── ws broadcast (state + events) ──────┘
```
- Actions carry a `clientActionId`; on broadcast the client drops its matching optimistic action and re-applies from authority. (Same reconciliation pattern as the source app.)
- The client only ever renders a **view** of state (its own hidden info + public info). Hidden zones (Life Deck, hand) are redacted server-side per recipient.

## Packages
- **`@dbz/shared`** — no logic, only types + constants: card schema, enums (styles, card types, keywords), game-state shape, the action union and the event union. Everything else depends on this.
- **`@dbz/engine`** — pure functions. `reduce(state, action)`, plus subsystems: `pat.ts` (Physical Attack Table lookup), `combat.ts` (16-step attack sequence), `anger.ts`, `powerup.ts`, `victory.ts`, `setup.ts`. No I/O, no randomness except via an injected seeded RNG so games are deterministic/replayable.
- **`@dbz/scraper`** — Node script → `data/cards.json`. Crawls each set gallery on retrodbzccg.com and extracts `{ number, style, name, saga, rarity, imageUrl }` from the `i0.wp.com/.../uploads/YYYY/MM/<num>-<Style>-<Name>.jpg` pattern + alt text. Optionally downloads images to `data/images/` (gitignored).
- **`@dbz/server`** — `ws` server, room registry, per-connection redaction, reconnect tokens, spectators.
- **`@dbz/client`** — React + Vite. Board, zones, **Scouter** and **Anger Sword** widgets, deck builder, card browser.

## Card data & the "coverage" model
The galleries give us the **catalog** (number, name, style, saga, rarity, image) but **not** structured stats/rules text. So each card carries a `rules` block that is layered on incrementally, with a `coverage` status like the source app:
- `full` — power stages/PUR + all abilities modeled; the engine can resolve it end-to-end.
- `partial` — some abilities modeled.
- `metadata` — type/style/name known, no mechanical automation yet.
- `unknown` — catalog entry only.

This lets the game be playable early (unmodeled cards resolve as manual/tabletop actions) while automation coverage grows. The card browser surfaces coverage so players know what's automated.

> **PAT grid** and **power-level chart** are images in the CRD; `pat.ts` holds the table as data with the special-case rules (Z → 2, Bubbles → 3, D-bracket go-first) implemented now and a TODO to fill exact bracket values from a scouter scan.

## Game state shape (target)
```
GameState {
  seed, turnNumber, activePlayerIdx, step: Step, phase,
  players: PlayerState[]  // MP levels + current level, scouter (current power stage index),
                          //   anger (0..5), PUR, zones (lifeDeck, hand, discard, inPlay,
                          //   drills, allies[], dragonBalls, removed), sensei, mastery,
                          //   alignment
  combat?: CombatState    // attacker/defender, controlOfCombat, current attack, stack of pending steps
  pendingChoice?: Prompt  // when the engine needs a player decision (defend? redirect? capture?)
  log: Event[]
  winner?, victoryType?
}
```
The engine surfaces required decisions as `pendingChoice` prompts (defend/redirect/capture/Empower amount/etc.), and the client renders them — the "assisted but authoritative" loop.

## Build order
1. `@dbz/shared` schema (unblocks all).
2. `@dbz/scraper` → real `data/cards.json`.
3. `@dbz/engine` (setup → power-up → anger → combat).
4. `@dbz/server` rooms.
5. `@dbz/client` board + scouter + anger sword + deck builder + browser.
