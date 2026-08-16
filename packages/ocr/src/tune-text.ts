/**
 * Offline text-reconstruction tuner.
 *
 * Rebuilds each fixture card's text from the per-word data stored in
 * ocr.tts.json (no re-OCR), sweeping the confidence threshold and trailing-junk
 * trimming, and scores each configuration's CER against the hand-transcribed
 * ground truth. Prints the matrix so the winning config is chosen on evidence.
 *
 *   node --experimental-strip-types src/tune-text.ts
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { correct, type OcrRecord } from './shared.ts';
import { correctText, type Template } from './phrases.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');

interface Truth { name: string; saga: string; text?: string }
type Cfg = { label: string; minConf: number; digitConf?: number; trim: boolean; snap: boolean };

const norm = (s: string) =>
  s.toLowerCase().replace(/[™®"“”]/g, '').replace(/([a-z])-\s+([a-z])/g, '$1$2').replace(/\s+/g, ' ').trim();

function lev(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i, ...new Array<number>(b.length).fill(0)];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** Rebuild lines from stored words: group by row (y), join, filter. */
export function rebuildText(
  words: Array<{ t: string; c: number; y: number }>,
  opts: { minConf: number; trimTrailingJunk: boolean; maxY?: number; digitConf?: number },
): string {
  const rows: Array<{ y: number; parts: Array<{ t: string; c: number }> }> = [];
  for (const w of words) {
    // Digits carry the parser's numbers; keep them at a lower bar.
    const digitOk = /^[+\-]?\d+[.,]?$/.test(w.t) && w.c >= (opts.digitConf ?? opts.minConf);
    if (w.c < opts.minConf && !digitOk) continue;
    if (opts.maxY !== undefined && w.y > opts.maxY) continue;
    const row = rows.find((r) => Math.abs(r.y - w.y) <= 0.014);
    if (row) row.parts.push(w);
    else rows.push({ y: w.y, parts: [w] });
  }
  rows.sort((a, b) => a.y - b.y);
  let lines = rows.map((r) => ({
    text: r.parts.map((p) => p.t).join(' ').replace(/\s+/g, ' ').trim(),
    conf: r.parts.reduce((s, p) => s + p.c, 0) / r.parts.length,
  })).filter((l) => (l.text.match(/[A-Za-z0-9]/g) ?? []).length >= 3);

  if (opts.trimTrailingJunk) {
    // Rules text ends at the last line that looks like a sentence; the flavor
    // band and frame junk below it are mostly non-words.
    const wordy = (t: string) => {
      const words2 = t.split(/\s+/);
      const vowelly = words2.filter((w) => /[aeiou]/i.test(w) && w.length >= 2).length;
      return vowelly / words2.length >= 0.6;
    };
    let last = lines.length - 1;
    while (last >= 0 && !(wordy(lines[last]!.text) && /\.\s*$/.test(lines[last]!.text))) last--;
    if (last >= 0) lines = lines.slice(0, last + 1);
  }
  return lines.map((l) => l.text).join('\n');
}

async function main(): Promise<void> {
  const fixture = JSON.parse(await readFile(join(here, 'fixtures', 'ground-truth.json'), 'utf8')) as { cards: Truth[] };
  const records = JSON.parse(await readFile(join(root, 'data', 'ocr.tts.json'), 'utf8')) as OcrRecord[];
  const templates = (JSON.parse(await readFile(join(root, 'data', 'phrases.tts.json'), 'utf8')) as { templates: Template[] }).templates;
  const byKey = new Map(records.map((r) => [`${r.name.toLowerCase()}|${r.saga}`, r]));

  const truths = fixture.cards.filter((c) => c.text);
  const configs: Cfg[] = [];
  for (const minConf of [35, 40, 45]) {
    for (const digitConf of [0, 10, 20, minConf]) {
      for (const snap of [false, true]) configs.push({ label: `conf>=${minConf} digit>=${digitConf} trim=y snap=${snap ? 'y' : 'n'}`, minConf, digitConf, trim: true, snap });
    }
  }

  console.log(`${truths.length} ground-truth texts; ${configs.length} configs\n`);
  const results: Array<{ label: string; cer: number }> = [];
  for (const cfg of configs) {
    let total = 0;
    for (const truth of truths) {
      const rec = byKey.get(`${truth.name.toLowerCase()}|${truth.saga}`);
      if (!rec?.words) continue;
      let text = correct(rebuildText(rec.words, { minConf: cfg.minConf, trimTrailingJunk: cfg.trim, ...(cfg.digitConf !== undefined ? { digitConf: cfg.digitConf } : {}) }));
      if (cfg.snap) text = correctText(text, templates).text;
      const want = norm(truth.text!);
      total += lev(norm(text), want) / Math.max(1, want.length);
    }
    const cer = total / truths.length;
    results.push({ label: cfg.label, cer });
  }
  results.sort((a, b) => a.cer - b.cer);
  for (const r of results) console.log(`  ${(r.cer * 100).toFixed(1).padStart(5)}%  ${r.label}`);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()!);
if (isMain) main().catch((e: unknown) => { console.error(e); process.exit(1); });
