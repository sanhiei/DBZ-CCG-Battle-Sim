# Filling in the Physical Attack Table (PAT)

The PAT is the grid printed on a **scouter**. For a physical attack, you compare the **attacker's** current power rating and the **defender's** current power rating and read the cell where they meet — that cell is the **Base Damage in power stages** (CRD §12, ~L426).

The numeric grid is an image in the CRD, so it isn't in `CRD.txt`. You're reconstructing it; drop the result into **`data/pat.json`** (copy `data/pat.template.json`) and the engine + server will use it. Until then the engine uses a clearly-marked placeholder (`isPlaceholderPat()` returns true) so combat is exercisable.

## Schema (`data/pat.json`)

```jsonc
{
  "placeholder": false,
  "special": { "zResult": 2 },   // if either personality has 'Z' power stages, result is always 2
  "brackets": [                  // ordered low -> high by power rating
    { "letter": "A", "minRating": 0,   "maxRating": 199 },
    { "letter": "B", "minRating": 200, "maxRating": 499 },
    ...
    { "letter": "Z", "minRating": 100000, "maxRating": 999999 }
  ],
  "damage": [                    // damage[attackerBracketIndex][defenderBracketIndex] = base damage (power stages)
    [1, 1, 1, ...],              // attacker in bracket A vs defenders A, B, C, ...
    [2, 1, 1, ...],              // attacker in bracket B ...
    ...
  ]
}
```

### How to fill it
1. **Brackets** — how the scouter groups power ratings into columns/rows. Each bracket is an inclusive `minRating..maxRating`. Ranges must be contiguous and cover every rating a personality can reach (ratings above the top clamp to the last bracket). Use the exact letters printed on the scouter (`A`, `B`, … up through the top). `Z` power-stage personalities are handled by `special.zResult`, so you don't need a numeric `Z` bracket unless the scouter uses one.
2. **damage matrix** — a square grid, one row per bracket (attacker) and one column per bracket (defender), in the same order as `brackets`. Each cell is the Base Damage (power stages) the attack deals. Read straight off the scouter.
3. Set `"placeholder": false` and remove `_comment`.

### Rules the engine already applies (don't encode these in the grid)
- **Z power stages** → result is always `special.zResult` (2). (King Kai, Grand Kai, Supreme Kai, Supreme West Kai, Mr. Popo.)
- **Bubbles** "Tuff Enuff only" physical attack → base damage always 3 — this is card-specific and handled in combat, not the table.
- **D-Power (go-first) rule** — uses the `D` bracket (`bracketOf(rating) >= indexOf('D')`), so make sure a bracket is lettered `"D"`.

Once `data/pat.json` exists, the server loads it via `setPatTable(...)` at startup and every physical attack resolves with the real numbers.
