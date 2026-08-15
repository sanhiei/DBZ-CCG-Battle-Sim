/**
 * Loads the reconstructed Physical Attack Table into the engine at startup.
 *
 * Without this the engine falls back to PLACEHOLDER_PAT and every physical
 * attack resolves on invented numbers, so a malformed or missing table is
 * surfaced loudly rather than silently tolerated.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPlaceholderPat, setPatTable, type PatTable } from '@dbz/engine';
import { findDataDir } from './catalog.js';

export interface PatLoadResult {
  loaded: boolean;
  /** True when combat is running on invented numbers. */
  placeholder: boolean;
  source?: string;
  warning?: string;
}

/** Reject a table that would silently produce wrong damage. */
export function validatePatTable(table: PatTable): string | undefined {
  return validate(table);
}

function validate(table: PatTable): string | undefined {
  if (!Array.isArray(table.brackets) || table.brackets.length === 0) return 'no brackets';
  if (!Array.isArray(table.damage)) return 'no damage matrix';
  if (table.damage.length !== table.brackets.length) {
    return `damage has ${table.damage.length} rows but there are ${table.brackets.length} brackets`;
  }
  for (const [i, row] of table.damage.entries()) {
    if (!Array.isArray(row) || row.length !== table.brackets.length) {
      return `damage row ${i} must have ${table.brackets.length} columns`;
    }
    if (row.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return `damage row ${i} has non-numeric cells`;
  }
  if (typeof table.special?.zResult !== 'number') return 'special.zResult must be a number';
  for (const [i, b] of table.brackets.entries()) {
    if (typeof b.minRating !== 'number' || typeof b.maxRating !== 'number' || b.minRating > b.maxRating) {
      return `bracket ${b.letter ?? i} has an invalid range`;
    }
  }
  // The D-Power go-first rule (CRD setup step 4) looks up a 'D' bracket.
  if (!table.brackets.some((b) => b.letter === 'D')) return "no bracket lettered 'D' (needed by the go-first rule)";
  return undefined;
}

export function loadPatTable(dataDir: string = findDataDir()): PatLoadResult {
  const path = join(dataDir, 'pat.json');
  if (!existsSync(path)) {
    return { loaded: false, placeholder: true, warning: `no ${path} — combat is using the PLACEHOLDER PAT` };
  }
  let table: PatTable;
  try {
    table = JSON.parse(readFileSync(path, 'utf8')) as PatTable;
  } catch (err) {
    return { loaded: false, placeholder: true, warning: `could not parse ${path}: ${String(err)}` };
  }
  const invalid = validate(table);
  if (invalid) {
    return { loaded: false, placeholder: true, warning: `ignoring ${path} — ${invalid}` };
  }
  setPatTable(table);
  const result: PatLoadResult = { loaded: true, placeholder: isPlaceholderPat(), source: path };
  if (result.placeholder) result.warning = `${path} is flagged "placeholder": true — combat damage is not canonical`;
  return result;
}
