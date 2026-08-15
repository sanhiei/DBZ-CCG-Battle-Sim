/**
 * Layout-aware field extraction.
 *
 * The first OCR pass assumed each field sits at a fixed fraction of the card.
 * Surveying cards across all eleven sagas showed that is simply false: Bulma's
 * scouter is a narrow blue column, Captain Ginyu's has no pills at all, and the
 * type banner is an embossed metallic plate whose width tracks its own text.
 * Fixed rectangles produced 62% untyped cards and only 20% clean ladders.
 *
 * So instead of trusting geometry, this module reads Tesseract's per-word
 * bounding boxes over a generous region and identifies fields by their
 * STRUCTURE — a scouter ladder is a descending column of numbers ending at
 * zero, wherever it happens to sit. Structure also validates: a run of digits
 * that does not descend to zero is not a ladder, which is what stops card art
 * from being mistaken for a personality's scouter.
 */
import sharp from 'sharp';
import type { Scheduler } from 'tesseract.js';
import type { Rect } from './shared.ts';

/** A recognised word, in normalised card coordinates (0..1). */
export interface Word {
  text: string;
  conf: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Search areas. Deliberately generous — structure does the real work. */
export const AREAS = {
  /**
   * Right-hand strip holding the scouter ladder. Starts at 0.68, not 0.60:
   * a wider area reaches into the rules panel, and stray digits from card text
   * were being accepted as ladder rungs.
   */
  ladder: { x0: 0.68, y0: 0.02, x1: 1.0, y1: 0.98 } satisfies Rect,
  /**
   * Top-left level badge. Measured off unscaled crops at x 0.09-0.17 across
   * six sagas — an earlier estimate taken from a *resized* montage put this at
   * x 0.005-0.14, which found zero words on every card.
   */
  level: { x0: 0.055, y0: 0.008, x1: 0.215, y1: 0.105 } satisfies Rect,
  /** Left margin holding the PUR badge; its height varies a lot by frame. */
  pur: { x0: 0.015, y0: 0.44, x1: 0.225, y1: 0.83 } satisfies Rect,
  /**
   * Type plate band. x0 must stay left of 0.15: at 0.25 the plate was clipped
   * to "l Combat" and "on-Combat", which read as plain Combat.
   */
  typeBanner: { x0: 0.08, y0: 0.462, x1: 1.0, y1: 0.578 } satisfies Rect,
  /**
   * Everything below the type plate. y0 was 0.5, which overlapped the plate —
   * 903 cards' text arrived prefixed "Physical Combat | ..." and merged rows
   * sometimes ate the first sentence's qualifier. The parser now tolerates
   * that, but the next full OCR run should not produce it at all.
   */
  rules: { x0: 0.06, y0: 0.585, x1: 0.99, y1: 0.93 } satisfies Rect,
};

/** Minimum glyph height (fraction of card) for a PUR badge digit. */
const PUR_MIN_HEIGHT = 0.032;
/** A ladder rung must sit within this much of the column's median centre. */
const LADDER_COLUMN_TOLERANCE = 0.11;
/** Real scouters print 10-12 rungs; art noise rarely forms this many. */
const LADDER_MIN_RUNGS = 6;

export type Preprocess = 'text' | 'invert' | 'sharp';

/**
 * Crop, preprocess and OCR one area, returning words in normalised card
 * coordinates so callers can reason about position independently of the crop.
 */
export async function ocrArea(
  scheduler: Scheduler,
  imagePath: string,
  area: Rect,
  cardW: number,
  cardH: number,
  mode: Preprocess = 'text',
): Promise<{ words: Word[]; text: string; conf: number }> {
  const left = Math.max(0, Math.round(area.x0 * cardW));
  const top = Math.max(0, Math.round(area.y0 * cardH));
  const width = Math.max(1, Math.min(cardW, Math.round(area.x1 * cardW)) - left);
  const height = Math.max(1, Math.min(cardH, Math.round(area.y1 * cardH)) - top);

  const scale = mode === 'invert' ? 4 : 3;
  let pipe = sharp(imagePath).extract({ left, top, width, height }).grayscale().resize({ width: width * scale }).normalize();
  if (mode === 'invert') pipe = pipe.threshold(175).negate();
  else if (mode === 'sharp') pipe = pipe.sharpen({ sigma: 1.5 });
  else pipe = pipe.sharpen();
  const buf = await pipe.png().toBuffer();

  const result = (await scheduler.addJob('recognize', buf, {}, { blocks: true, text: true })) as {
    data: { text: string; confidence: number; blocks?: TessBlock[] };
  };

  // Crop pixel space -> normalised card space.
  const scaledW = width * scale;
  const scaledH = height * scale;
  const toCardX = (x: number) => area.x0 + (x / scaledW) * (area.x1 - area.x0);
  const toCardY = (y: number) => area.y0 + (y / scaledH) * (area.y1 - area.y0);

  const words: Word[] = [];
  for (const block of result.data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const w of line.words ?? []) {
          const text = (w.text ?? '').trim();
          if (!text) continue;
          words.push({
            text,
            conf: w.confidence ?? 0,
            x0: toCardX(w.bbox.x0),
            y0: toCardY(w.bbox.y0),
            x1: toCardX(w.bbox.x1),
            y1: toCardY(w.bbox.y1),
          });
        }
      }
    }
  }
  return { words, text: (result.data.text ?? '').trim(), conf: result.data.confidence ?? 0 };
}

interface TessBlock {
  paragraphs?: Array<{ lines?: Array<{ words?: Array<{ text?: string; confidence?: number; bbox: { x0: number; y0: number; x1: number; y1: number } }> }> }>;
}

/** Group words into visual rows by vertical overlap of their boxes. */
export function groupRows(words: Word[], tolerance = 0.012): Word[][] {
  const sorted = [...words].sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
  const rows: Word[][] = [];
  for (const w of sorted) {
    const mid = (w.y0 + w.y1) / 2;
    const row = rows.at(-1);
    const rowMid = row ? row.reduce((s, r) => s + (r.y0 + r.y1) / 2, 0) / row.length : Infinity;
    if (row && Math.abs(mid - rowMid) <= tolerance) row.push(w);
    else rows.push([w]);
  }
  return rows.map((r) => r.sort((a, b) => a.x0 - b.x0));
}

export interface LadderResult {
  ratings: Array<number | 'Z'>;
  ok: boolean;
  reason?: string;
  /** Fraction of card height the ladder spans. */
  span: number;
  conf: number;
}

/** Plausible ceiling for a power rating; anything larger is a misread. */
const MAX_RATING = 200_000_000;

/**
 * Find a scouter ladder among digit words.
 *
 * A real ladder is unmistakable once you look at its structure rather than its
 * position: numbers stacked in a column, strictly DESCENDING top to bottom, and
 * bottoming out at the zero stage (printed variously as 00, 000, 0000, 00,000).
 * Requiring all three is what keeps busy card art from registering as a scouter.
 */
export function detectLadder(words: Word[]): LadderResult {
  const rows = groupRows(words.filter((w) => /[0-9Z]/i.test(w.text)));

  // Each pill is one value; the digit whitelist may split "1,500,000" into
  // several words, so rejoin each row left-to-right.
  let candidates: Array<{ value: number | 'Z'; y: number; x: number; conf: number }> = [];
  for (const row of rows) {
    const joined = row.map((w) => w.text).join('').replace(/[^0-9Z]/gi, '');
    if (!joined) continue;
    const conf = row.reduce((s, w) => s + w.conf, 0) / row.length;
    const y = row.reduce((s, w) => s + (w.y0 + w.y1) / 2, 0) / row.length;
    const x = row.reduce((s, w) => s + (w.x0 + w.x1) / 2, 0) / row.length;
    if (/^Z+$/i.test(joined)) candidates.push({ value: 'Z', y, x, conf });
    else {
      const n = Number(joined);
      if (Number.isFinite(n) && n <= MAX_RATING) candidates.push({ value: n, y, x, conf });
    }
  }

  if (candidates.length < LADDER_MIN_RUNGS) {
    return { ratings: [], ok: false, reason: `only ${candidates.length} numeric rows`, span: 0, conf: 0 };
  }

  // A scouter is a COLUMN. Discard rows that sit off to one side — those are
  // digits bleeding in from the rules panel, not rungs. Geometry is the right
  // test here: Tesseract reports confidence 0 on these stylised italic digits
  // even when it reads them correctly, so confidence cannot do this job.
  const centres = candidates.map((c) => c.x).sort((a, b) => a - b);
  const median = centres[Math.floor(centres.length / 2)]!;
  candidates = candidates.filter((c) => Math.abs(c.x - median) <= LADDER_COLUMN_TOLERANCE);

  if (candidates.length < LADDER_MIN_RUNGS) {
    return { ratings: [], ok: false, reason: `only ${candidates.length} rows in the column`, span: 0, conf: 0 };
  }

  // Longest strictly-descending run, scanning top to bottom.
  const nums = candidates.filter((c): c is (typeof candidates)[number] & { value: number } => typeof c.value === 'number');
  const best = longestDescending(nums);
  const zs = candidates.filter((c) => c.value === 'Z');

  const span = best.length ? Math.abs(best.at(-1)!.y - best[0]!.y) : 0;
  const conf = best.length ? best.reduce((s, c) => s + c.conf, 0) / best.length : 0;

  if (best.length + zs.length < LADDER_MIN_RUNGS) {
    return { ratings: [], ok: false, reason: `no descending run of ${LADDER_MIN_RUNGS}+`, span, conf };
  }
  // The zero stage anchors the bottom of every scouter.
  if (best.length && best.at(-1)!.value !== 0) {
    return { ratings: [], ok: false, reason: `bottom rung is ${best.at(-1)!.value}, not 0`, span, conf };
  }
  // A genuine ladder runs down most of the card.
  if (span < 0.4) {
    return { ratings: [], ok: false, reason: `spans only ${(span * 100).toFixed(0)}% of height`, span, conf };
  }

  // Stored stage 0 first, so reverse the top-down reading order.
  const ratings: Array<number | 'Z'> = [...zs.map(() => 'Z' as const), ...best.map((c) => c.value).reverse()];
  return { ratings, ok: true, span, conf };
}

/** Score a ladder reading so competing preprocessings can be compared. */
export function ladderScore(r: LadderResult): number {
  if (!r.ok) return -1;
  return r.ratings.length * 10 + r.span * 20 + r.conf / 10;
}

function longestDescending<T extends { value: number }>(items: T[]): T[] {
  if (items.length === 0) return [];
  // Patience-style: track the best descending chain ending at each item.
  const chains: T[][] = [];
  for (const item of items) {
    let bestChain: T[] = [];
    for (const chain of chains) {
      if (chain.at(-1)!.value > item.value && chain.length > bestChain.length) bestChain = chain;
    }
    chains.push([...bestChain, item]);
  }
  return chains.reduce((a, b) => (b.length > a.length ? b : a), []);
}

/** Read the level badge: a single 1-5 in the top-left corner. */
export function detectLevel(words: Word[]): { level?: number; conf: number } {
  const digits = words
    .map((w) => ({ w, m: w.text.match(/[1-5]/) }))
    .filter((d) => d.m)
    .sort((a, b) => (b.w.x1 - b.w.x0) * (b.w.y1 - b.w.y0) - (a.w.x1 - a.w.x0) * (a.w.y1 - a.w.y0));
  const top = digits[0];
  if (!top) return { conf: 0 };
  return { level: Number(top.m![0]), conf: top.w.conf };
}

/**
 * Probe a badge (one large digit) with a SINGLE_CHAR worker.
 *
 * SPARSE_TEXT cannot segment a lone stylised glyph on a holographic fill — it
 * found zero words on Bulma's PUR badge in either polarity. Treating each
 * candidate box as exactly one character and letting the best read win is what
 * the badge layout actually calls for. Several candidate boxes are probed
 * because the badge's vertical position varies by frame family.
 */
export async function probeBadge(
  chars: Scheduler,
  imagePath: string,
  boxes: Rect[],
  cardW: number,
  cardH: number,
  valid: RegExp,
): Promise<{ value?: number; conf: number }> {
  let best: { value: number; conf: number } | undefined;
  for (const box of boxes) {
    for (const mode of ['text', 'invert'] as const) {
      const left = Math.max(0, Math.round(box.x0 * cardW));
      const top = Math.max(0, Math.round(box.y0 * cardH));
      const width = Math.max(1, Math.min(cardW, Math.round(box.x1 * cardW)) - left);
      const height = Math.max(1, Math.min(cardH, Math.round(box.y1 * cardH)) - top);
      let pipe = sharp(imagePath).extract({ left, top, width, height }).grayscale().resize({ width: width * 4 }).normalize();
      pipe = mode === 'invert' ? pipe.threshold(175).negate() : pipe.sharpen();
      const buf = await pipe.png().toBuffer();
      const r = (await chars.addJob('recognize', buf)) as { data: { text: string; confidence: number } };
      const m = r.data.text.trim().match(valid);
      if (!m) continue;
      const candidate = { value: Number(m[0]), conf: r.data.confidence };
      if (!best || candidate.conf > best.conf) best = candidate;
    }
  }
  return best ?? { conf: 0 };
}

/** Candidate boxes for the PUR badge, top to bottom of the left margin. */
export const PUR_BOXES: Rect[] = [
  { x0: 0.01, y0: 0.42, x1: 0.23, y1: 0.58 },
  { x0: 0.01, y0: 0.55, x1: 0.23, y1: 0.71 },
  { x0: 0.01, y0: 0.68, x1: 0.23, y1: 0.84 },
];

/** Candidate boxes for the level badge in the top-left corner. */
export const LEVEL_BOXES: Rect[] = [
  { x0: 0.05, y0: 0.005, x1: 0.22, y1: 0.11 },
];

/**
 * Read the PUR badge from the left margin. Several digits can appear in that
 * strip (set numbering, stray art), but PUR is printed much larger, so the
 * biggest glyph wins.
 */
export function detectPur(words: Word[]): { pur?: number; conf: number } {
  // The left margin also catches the first words of the rules panel, so size is
  // the discriminator: a PUR badge glyph is ~6% of the card's height while body
  // text is ~2%. Without this, digits from phrases like "4 power stages" win.
  const digits = words
    .filter((w) => w.y1 - w.y0 >= PUR_MIN_HEIGHT)
    .map((w) => ({ w, m: w.text.match(/\d/) }))
    .filter((d) => d.m)
    .map((d) => ({ ...d, area: (d.w.x1 - d.w.x0) * (d.w.y1 - d.w.y0) }))
    .sort((a, b) => b.area - a.area);
  const top = digits[0];
  if (!top) return { conf: 0 };
  const value = Number(top.m![0]);
  // PUR is a small single digit; anything else is a misread.
  if (!Number.isFinite(value) || value > 9) return { conf: top.w.conf };
  return { pur: value, conf: top.w.conf };
}

/**
 * Rebuild rules text from words, dropping low-confidence fragments.
 *
 * Confidence is a better noise filter than the character-shape heuristics the
 * first pass used: frame and art fragments score far below real printed text.
 */
export function textFromWords(words: Word[], minWordConf = 40): string {
  const rows = groupRows(words.filter((w) => w.conf >= minWordConf), 0.014);
  const lines: string[] = [];
  for (const row of rows) {
    const line = row.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const alnum = (line.match(/[A-Za-z0-9]/g) ?? []).length;
    if (alnum < 3) continue;
    const rowConf = row.reduce((s, w) => s + w.conf, 0) / row.length;
    if (rowConf < minWordConf + 10 && alnum < 8) continue;
    lines.push(line);
  }
  return lines.join('\n').trim();
}
