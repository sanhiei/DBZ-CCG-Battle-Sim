/**
 * Physical Attack Table (PAT).
 *
 * The PAT compares the attacker's and defender's power RATINGS and yields Base
 * Damage (in power stages) for a physical attack. On a scouter the ratings are
 * grouped into lettered brackets and you read the cell where the two brackets
 * meet. The exact numeric grid is being reconstructed by the user — fill
 * `data/pat.json` (see docs/PAT.md) and inject it via `setPatTable`. Until then a
 * clearly-marked PLACEHOLDER is used so physical combat is exercisable.
 *
 * Special rules implemented per CRD:
 *   - If either personality has 'Z' power stages, the result is always 2.
 *   - The "D bracket" go-first rule uses `bracketOf`.
 *   - Bubbles' "Tuff Enuff only" fixed-3 rule is card-specific (handled in combat).
 */
import type { PowerRating } from '@dbz/shared';

export interface PatBracket {
  letter: string;
  /** Inclusive rating range this bracket covers. */
  minRating: number;
  maxRating: number;
}

export interface PatTable {
  /** Ordered low -> high. Ratings outside all ranges clamp to the nearest end. */
  brackets: PatBracket[];
  /** damage[attackerBracketIdx][defenderBracketIdx] = base damage (power stages). */
  damage: number[][];
  special: { zResult: number };
  /** Marks the built-in placeholder so callers/UI can warn. */
  placeholder?: boolean;
}

/**
 * PLACEHOLDER only — NOT the real SCORE PAT values. Replace with data/pat.json.
 * 6 coarse brackets so combat runs end-to-end before the real grid is provided.
 */
export const PLACEHOLDER_PAT: PatTable = {
  placeholder: true,
  brackets: [
    { letter: 'A', minRating: 0, maxRating: 199 },
    { letter: 'B', minRating: 200, maxRating: 499 },
    { letter: 'C', minRating: 500, maxRating: 899 },
    { letter: 'D', minRating: 900, maxRating: 1399 },
    { letter: 'E', minRating: 1400, maxRating: 2999 },
    { letter: 'F', minRating: 3000, maxRating: 999999 },
  ],
  // Rough monotonic placeholder: bigger attacker advantage -> more damage.
  damage: [
    [1, 1, 1, 1, 1, 1],
    [2, 1, 1, 1, 1, 1],
    [3, 2, 2, 1, 1, 1],
    [4, 3, 2, 2, 1, 1],
    [5, 4, 3, 2, 2, 1],
    [6, 5, 4, 3, 2, 2],
  ],
  special: { zResult: 2 },
};

let active: PatTable = PLACEHOLDER_PAT;

export function setPatTable(table: PatTable): void {
  active = table;
}
export function getPatTable(): PatTable {
  return active;
}
export function isPlaceholderPat(): boolean {
  return active.placeholder === true;
}

export function isZ(rating: PowerRating): rating is 'Z' {
  return rating === 'Z';
}

/** Bracket index for a numeric rating (clamped). Used by the D-power rule too. */
export function bracketOf(rating: number, table: PatTable = active): number {
  const b = table.brackets;
  for (let i = 0; i < b.length; i++) {
    if (rating >= b[i]!.minRating && rating <= b[i]!.maxRating) return i;
  }
  return rating < b[0]!.minRating ? 0 : b.length - 1;
}

export function bracketLetterOf(rating: PowerRating, table: PatTable = active): string {
  if (isZ(rating)) return 'Z';
  return table.brackets[bracketOf(rating, table)]?.letter ?? '?';
}

/** Base Damage (power stages) for a physical attack, per the PAT. */
export function computeBaseDamage(
  attacker: PowerRating,
  defender: PowerRating,
  table: PatTable = active,
): number {
  if (isZ(attacker) || isZ(defender)) return table.special.zResult;
  const ai = bracketOf(attacker, table);
  const di = bracketOf(defender, table);
  return table.damage[ai]?.[di] ?? 0;
}
