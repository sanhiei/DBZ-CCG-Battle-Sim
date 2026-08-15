# UI design — signature widgets

Decision (2026-08): **no assets from the TTS mod are used in the client.** Card
faces are the only thing taken from it, and only as local data. The mod's 3D
scouter/anger-sword models are the author's assets and the wrong aesthetic
anyway — the client's widgets are built from scratch as stylized 2D (SVG +
CSS), DBZ-inspired but original. No WebGL; everything theme-aware with
reduced-motion fallbacks.

## Scouter (power readout)

A Ginyu-Force-era HUD lens, not a literal 3D scouter:

- Hex-tessellated translucent lens (teal glass for heroes, villain decks tint
  crimson) clipped to an angular hexagonal frame, worn "over" the personality's
  portrait corner.
- Big angular **PAT bracket letter** (A-I) as the focal glyph — this is what
  physical combat actually reads — with the exact **power rating** beneath it
  in the blocky SCORE-style numerals, and the current **power stage pips**
  (0..N) along the lens's lower arc.
- On stage change: a one-pass scanline shimmer and the rating counter rolls.
- At stage 0: the lens cracks (stroke overlay), a nod to every scouter ever.
- Data comes straight from `PersonalityInPlay.stageIndex` / `currentRating` and
  `bracketLetterOf()` — the widget renders engine truth, never computes rules.

## Anger Sword (anger gauge)

A vertical blade silhouette (Z-Sword profile) that charges with ki:

- Five segments fill hilt→tip as anger climbs 0→5; each segment is a ki flame
  lick, not a battery bar.
- At 5: the blade ignites — aura flame outline (gold for heroes, violet for
  villains), a screen-shake-free flash, and the MP level-advance animation
  fires as the engine emits `personalityAdvanced`; the gauge then drains to 0
  per the CRD.
- Anger from card effects pulses the newly-lit segment once.

## Principles

- Widgets are **read-only views of GameState** — all rules live in the engine.
- Stylized flat/cel look matching the card frames' era; no photorealism.
- Both widgets must be legible at spectator zoom: bracket letter and lit
  segment count readable at 32px tall.
