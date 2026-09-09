# Physical Attack Table

Drop a scan of the printed PAT card here named `default` — `default.jpg`,
`default.png` or `default.webp` — and the PAT button shows the real card
instead of the grid the client draws from `data/pat.json`.

**Crop it to the one table the engine uses.** A scan of the whole card often
carries two tables (Fusion Saga on top, Buu Saga Table B underneath). The engine
runs the Fusion grid — that is what `data/pat.json` holds, and what the live
"this attack: C vs E = 2 power stages" line above the image is computed from —
so showing both would put numbers on screen that the game is not using, at half
the size. `complete.jpg`, if present, is just the uncropped original kept for
reference; nothing reads it.

Same reasoning as `data/playmats/`: franchise artwork, served by the host,
not redistributed here.

Nothing breaks without one. Without a scan the client draws the table from the
data, which is the same table — verified cell by cell against the printed card:
nine brackets, and a 9x9 grid identical to `data/pat.json`.

Either way the live lookup is printed above it, because an image cannot
highlight a cell.
