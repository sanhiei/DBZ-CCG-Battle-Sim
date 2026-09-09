# Playmats

Drop an image here named `default` — `default.jpg`, `default.png` or
`default.webp` — and it becomes the table surface for **both** players.

The images themselves are not in this repository. They are franchise artwork,
for the same reason the card faces under `data/images-tts/` are not: the machine
hosting the game serves them, the way any site serves its own images, and
nothing is redistributed here.

Nothing breaks without one. The board falls back to its plain surface, so a
fresh clone with no art still plays.

A player can also upload their own mat from the board, which overrides this one
**on their half only** — it is held in their browser and never crosses the wire.
