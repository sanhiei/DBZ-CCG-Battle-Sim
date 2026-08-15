# DBZ Automated Simulator

An automated, online multiplayer simulator for the **SCORE / Panini-era Dragon Ball Z Collectible Card Game** (the "retro" DBZ CCG), built around a full rules engine driven by the game's **Comprehensive Rules Document (CRD)**.

> **The CRD is law.** Where the CRD ([`docs/CRD.txt`](docs/CRD.txt)) and the printed rulebook disagree, the CRD wins. The [Buu Saga rulebook](https://retrodbzccg.com/rules/dragon-ball-z-ccg-rulebook-buu-saga/) is background context only.

This project takes architectural inspiration from an existing automated FFTCG/MTG tabletop ("Aethergate"): a **shared, authoritative rules reducer** running on both an authoritative server and the clients (for optimistic prediction), WebSocket rooms, a card browser, and a deck builder. The interface here is rebuilt to be more approachable, with two signature DBZ widgets:

- **Scouter** — a power-level readout on every personality and ally, tracking current **power stage / power rating** and driving the **Physical Attack Table (PAT)** comparison.
- **Anger Sword** — a vertical anger gauge (0→5). At **5+ anger** a Main Personality immediately advances a level and anger resets to 0.

## Monorepo layout

| Package | Role |
| --- | --- |
| `@dbz/shared` | Card schema, game-state types, client/server action & event protocol. |
| `@dbz/engine` | Authoritative rules engine: turn/step sequencing, power-up, anger→advancement, ally rules, PAT + combat resolution, victory checks. |
| `@dbz/scraper` | Crawls the retrodbzccg.com galleries into a structured card catalog (`data/cards.json`). |
| `@dbz/server` | Node WebSocket server: rooms, sessions, reconnect, spectators; hosts the authoritative engine. |
| `@dbz/client` | React + Vite UI: board, zones, scouter, anger sword, deck builder, card browser. |

## Status

Build order is **schema → scraper → engine → server → client**; the client is what's left.

| Package | State |
| --- | --- |
| `@dbz/shared` | Card/state/protocol types in place. |
| `@dbz/scraper` + `@dbz/ocr` | Saiyan Saga scraped, OCR'd, and enriched (`data/cards.saiyan.enriched.json`, 266 cards). |
| `@dbz/engine` | Setup, turn/step sequencing, power-up, anger, PAT + combat, card abilities. 23 tests. |
| `@dbz/server` | Rooms, lobby, deck legality, redaction, reconnect, spectators. 49 tests. |
| `@dbz/client` | Not started. |

See `docs/ARCHITECTURE.md` for the design and `docs/RULES-NOTES.md` for the engine-relevant rules distilled from the CRD.

## Getting started

```bash
npm install
npm run scrape        # build data/cards.json from the card galleries
npm run typecheck
npm test
npm run dev:server    # authoritative game server on :8787
npm run dev:client    # web client (not built yet)
```

`npm run dev:server` compiles once and runs under `node --watch`; for live recompiles run
`npm run watch -w @dbz/server` alongside it.

### Server surface

| Endpoint | Purpose |
| --- | --- |
| `ws://host/` | Game protocol — see `ClientMessage` / `ServerMessage` in `@dbz/shared`. |
| `GET /health` | Liveness, room count, catalog size. |
| `GET /api/cards` | The card catalog, for the card browser and deck builder. |

Joining a room code that isn't in use creates that room — there's no separate "create" step.
The first two joiners take the seats, everyone after spectates, and the `token` from the
`session` message reclaims a seat after a disconnect. Environment: `PORT`, `HOST`,
`DBZ_DATA_DIR`, and `DBZ_ALLOW_SMALL_DECKS=1` to relax the 50-card minimum while testing.

## Legal / attribution

Dragon Ball Z, the DBZ CCG, and all card art are the property of their respective rights holders (Toei/Bird Studio; Score Entertainment / Panini). Card images are sourced from the community archive at retrodbzccg.com. This is a non-commercial fan simulator for playing cards you own.
