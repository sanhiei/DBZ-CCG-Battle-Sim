/**
 * Repairs single-rung ladder misreads by arithmetic, not by guessing.
 *
 * A scouter ladder is an arithmetic sequence: every rung above stage 0 differs
 * from its neighbour by a constant step. When exactly ONE rung breaks the
 * ordering and every other gap agrees on that step, the true value is
 * determined — prev + step — so restoring it is interpolation, not invention.
 *
 * In practice these are all dropped leading digits: 1,000,000 read as 100000,
 * or 2,150,000 read as 1150000. A vision agent reading the Buu-saga Gohan
 * called this exactly: "every other step is a uniform -70,000, so the true
 * printed value is almost certainly 2,150,000 with the leading 2 corrupted".
 *
 * Repairs are refused unless the evidence is unambiguous, and every repaired
 * card is flagged in needsReview so the change stays auditable.
 *
 *   node scripts/repair-ladders.mjs [--dry]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'data', 'cards.tts.enriched.json');
const dry = process.argv.includes('--dry');

const cards = JSON.parse(readFileSync(file, 'utf8'));

/**
 * Returns a repaired ladder, or null when the evidence does not determine one.
 * Only numeric rungs participate; 'Z' sits outside the ordering.
 */
function repairLadder(ladder) {
  if (!Array.isArray(ladder) || ladder.length < 5) return null;
  const nums = ladder.filter((v) => typeof v === 'number');
  if (nums.length !== ladder.length) return null; // contains 'Z'; leave alone

  // Gaps above stage 0. The 0 -> first rung gap is the card's base and is not
  // part of the constant step, so it is excluded.
  const gaps = [];
  for (let i = 2; i < nums.length; i++) gaps.push(nums[i] - nums[i - 1]);
  const breaks = [];
  for (let i = 1; i < nums.length; i++) if (nums[i] <= nums[i - 1]) breaks.push(i);
  if (breaks.length === 0) return null; // nothing to fix
  if (breaks.length > 2) return null; // too damaged to infer

  // The step is the value the healthy gaps agree on.
  const healthy = gaps.filter((g) => g > 0);
  const counts = new Map();
  for (const g of healthy) counts.set(g, (counts.get(g) ?? 0) + 1);
  let step = 0;
  let best = 0;
  for (const [g, n] of counts) if (n > best) { best = n; step = g; }
  // Require a clear consensus: most healthy gaps must agree.
  if (step <= 0 || best < healthy.length - 1 || best < 3) return null;

  const out = nums.slice();
  // A single bad rung shows up as one dip; both breaks point at the same index.
  const bad = breaks[0];
  const idx = breaks.length === 2 && breaks[1] === bad + 1 ? bad : bad;
  const prev = out[idx - 1];
  const expected = prev + step;
  // Interior rungs must also agree with the rung above them.
  const next = out[idx + 1];
  if (next !== undefined && next - expected !== step) return null;
  if (expected <= prev) return null;
  out[idx] = expected;

  // The result must now be strictly increasing, or the repair is not trusted.
  for (let i = 1; i < out.length; i++) if (out[i] <= out[i - 1]) return null;
  return { ladder: out, changedIndex: idx, from: nums[idx], to: expected, step };
}

let repaired = 0;
const details = [];
for (const c of cards) {
  const p = c.rules?.personality;
  if (!p?.powerRatings) continue;
  const fix = repairLadder(p.powerRatings);
  if (!fix) continue;
  details.push(`${c.name} [${c.saga}] stage ${fix.changedIndex}: ${fix.from} -> ${fix.to} (step ${fix.step})`);
  p.powerRatings = fix.ladder;
  (c.rules.needsReview ??= []).push('ladder:arithmeticRepair');
  repaired++;
}

for (const d of details) console.log('  ' + d);
console.log(`${dry ? '[dry] would repair' : 'repaired'} ${repaired} ladder(s)`);
if (!dry && repaired > 0) writeFileSync(file, JSON.stringify(cards, null, 2));
