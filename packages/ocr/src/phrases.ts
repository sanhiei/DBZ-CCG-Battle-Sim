/**
 * Corpus-level text correction.
 *
 * DBZ CCG rules text is heavily templated: "Remove from the game after use.",
 * "Stops a physical attack.", "Physical attack doing +N power stages of
 * damage." recur across hundreds of cards. Each card's OCR errors are
 * independent, so across the corpus the majority reading of a repeated
 * sentence is almost certainly the true printing. This module:
 *
 *   1. mines sentence templates (digits slotted as #) with their frequencies
 *      and a canonical raw representative (the most common exact casing), and
 *   2. snaps a noisy sentence to a canonical template when it is close enough,
 *      re-filling the digit slots FROM THE NOISY SENTENCE — a snap must never
 *      change a number ("+3" must not become the template's "+4").
 *
 * Snapping is refused when digit counts differ or similarity is below the
 * threshold; correction never invents content.
 */

export interface Template {
  /** Normalized form: lowercase, digits -> #, whitespace collapsed. */
  key: string;
  /** Most frequent raw spelling (original casing/punctuation). */
  canonical: string;
  /** How many cards carried an exact match of this normalized form. */
  count: number;
}

/** Sentence splitter tolerant of OCR (periods may be lost; newlines matter). */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 4);
}

export function normalizeKey(sentence: string): string {
  return sentence
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/[^a-z#+\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Mine templates from a corpus of card texts. */
export function mineTemplates(texts: string[], minCount = 8): Template[] {
  const byKey = new Map<string, Map<string, number>>();
  for (const text of texts) {
    for (const sentence of splitSentences(text)) {
      const key = normalizeKey(sentence);
      if (key.length < 8) continue;
      const raws = byKey.get(key) ?? new Map<string, number>();
      raws.set(sentence, (raws.get(sentence) ?? 0) + 1);
      byKey.set(key, raws);
    }
  }
  const out: Template[] = [];
  for (const [key, raws] of byKey) {
    const count = [...raws.values()].reduce((a, b) => a + b, 0);
    if (count < minCount) continue;
    const canonical = [...raws.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    out.push({ key, canonical, count });
  }
  return out.sort((a, b) => b.count - a.count);
}

/** Levenshtein with a band cutoff; returns Infinity when > maxDist. */
export function editDistance(a: string, b: string, maxDist: number): number {
  if (Math.abs(a.length - b.length) > maxDist) return Infinity;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i, ...new Array<number>(n).fill(0)];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (cur[j]! < rowMin) rowMin = cur[j]!;
    }
    if (rowMin > maxDist) return Infinity;
    prev = cur;
  }
  return prev[n]! <= maxDist ? prev[n]! : Infinity;
}

export interface SnapResult {
  text: string;
  snapped: boolean;
  template?: Template;
}

/**
 * Snap one sentence to the closest template if similarity clears `minRatio`.
 * Digits from the INPUT sentence are re-slotted into the template.
 */
export function snapSentence(sentence: string, templates: Template[], minRatio = 0.82): SnapResult {
  const key = normalizeKey(sentence);
  if (key.length < 8) return { text: sentence, snapped: false };

  let best: { t: Template; dist: number } | undefined;
  for (const t of templates) {
    if (t.key === key) return { text: fillDigits(t.canonical, sentence) ?? sentence, snapped: true, template: t };
    const maxDist = Math.floor(Math.max(key.length, t.key.length) * (1 - minRatio));
    const dist = editDistance(key, t.key, maxDist);
    if (dist !== Infinity && (!best || dist < best.dist)) best = { t, dist };
  }
  if (!best) return { text: sentence, snapped: false };

  const filled = fillDigits(best.t.canonical, sentence);
  if (filled === null) return { text: sentence, snapped: false }; // digit shape differs — refuse
  return { text: filled, snapped: true, template: best.t };
}

/**
 * Replace the digit runs in `canonical` with the digit runs from `source`,
 * in order. Returns null when the counts differ (never guess a number).
 */
function fillDigits(canonical: string, source: string): string | null {
  const slots = canonical.match(/\d+/g) ?? [];
  const values = source.match(/\d+/g) ?? [];
  if (slots.length !== values.length) return slots.length === 0 ? canonical : null;
  let i = 0;
  return canonical.replace(/\d+/g, () => values[i++]!);
}

/** Correct a whole card text; returns the text plus how many sentences snapped. */
export function correctText(
  text: string,
  templates: Template[],
  minRatio = 0.82,
): { text: string; snappedCount: number } {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return { text, snappedCount: 0 };
  let snappedCount = 0;
  const out = sentences.map((s) => {
    const r = snapSentence(s, templates, minRatio);
    if (r.snapped && r.text !== s) snappedCount++;
    return r.snapped ? r.text : s;
  });
  return { text: out.join('\n'), snappedCount };
}
