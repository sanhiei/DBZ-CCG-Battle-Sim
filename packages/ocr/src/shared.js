/**
 * Shared OCR primitives: card regions, image preprocessing, and the parsers
 * that turn raw Tesseract output into structured fields.
 *
 * Used by both drivers — `ocr.ts` (retrodbzccg gallery scans, ~400x550) and
 * `ocr-tts.ts` (Tabletop Simulator atlas slices, ~800x1100). Regions are stored
 * as fractions of the card so they hold at any resolution.
 */
import sharp from 'sharp';
/**
 * Regions as fractions of the card face.
 *
 * Calibrated against 800x1100 TTS slices by cropping and inspecting. The
 * earlier values clipped real content: `powerColumn` cut the leading digit off
 * every rating ("...,000,000" instead of "2,000,000"), `textBox` cut the right
 * edge off every line, and `powerText` truncated the last two lines of ability
 * text. Widen with care and re-inspect crops before trusting a change.
 */
export const REGIONS = {
    title: { x0: 0.03, y0: 0.0, x1: 0.72, y1: 0.085 },
    // Non-personality cards:
    typeLine: { x0: 0.04, y0: 0.455, x1: 0.96, y1: 0.575 },
    textBox: { x0: 0.13, y0: 0.615, x1: 0.96, y1: 0.87 },
    // Personality cards. powerColumn must exclude the card number above the
    // ladder and the SCORE logo below it, or both land in the parsed ratings.
    powerColumn: { x0: 0.71, y0: 0.11, x1: 0.995, y1: 0.875 },
    pur: { x0: 0.04, y0: 0.63, x1: 0.18, y1: 0.8 },
    level: { x0: 0.09, y0: 0.02, x1: 0.24, y1: 0.115 },
    powerText: { x0: 0.19, y0: 0.6, x1: 0.74, y1: 0.805 },
};
/** Frequent OCR confusions in this card set. */
const CORRECTIONS = [
    [/\bphusical\b/gi, 'physical'],
    [/\bpersanality'?s?\b/gi, 'personality'],
    [/\bpersonalitys\b/gi, "personality's"],
    [/\bTheu'?ve\b/gi, "They've"],
    [/\bTheu\b/gi, 'They'],
    [/\bpawer\b/gi, 'power'],
    [/\bdamoge\b/gi, 'damage'],
    [/\bopponenr\b/gi, 'opponent'],
    [/\bcombar\b/gi, 'combat'],
    [/\battock\b/gi, 'attack'],
    [/\bstoge\b/gi, 'stage'],
    [/\brotinq\b/gi, 'rating'],
    // Corpus-mined confusions (each surfaced as a repeated bad template by
    // mine-phrases.ts before being fixed here):
    [/\bdedared\b/gi, 'declared'],
    [/\bfnysical\b/gi, 'Physical'],
    [/(anger\s*)\|(?=\s*levels?)/gi, '$11'], // "anger | level" -> "anger 1 level"
    [/(limit\s*)\|(?=\s*per\b)/gi, '$11'], // "Limit | per deck"
    [/\b(empower|endurance)\s*\|/gi, '$1 1'],
    [/[ \t]+\n/g, '\n'],
    [/\n{3,}/g, '\n\n'],
    [/[ \t]{2,}/g, ' '],
];
export function correct(text) {
    let t = text;
    for (const [re, rep] of CORRECTIONS)
        t = t.replace(re, rep);
    return t.trim();
}
export function px(rect, w, h) {
    const left = Math.max(0, Math.round(rect.x0 * w));
    const top = Math.max(0, Math.round(rect.y0 * h));
    const right = Math.min(w, Math.round(rect.x1 * w));
    const bottom = Math.min(h, Math.round(rect.y1 * h));
    return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}
export async function regionBuffer(path, rect, w, h, opts = {}) {
    const region = px(rect, w, h);
    const mode = opts.mode ?? 'text';
    const scale = mode === 'invert' ? 4 : 3;
    let s = sharp(path).extract(region).grayscale().resize({ width: region.width * scale }).normalize();
    s = mode === 'invert' ? s.threshold(175).negate() : s.sharpen();
    return s.png().toBuffer();
}
/**
 * Drop OCR lines that are frame/art noise rather than card text.
 *
 * Even a well-placed crop catches a sliver of border or flavour text, which
 * Tesseract renders as things like `NY 8 WW AY Gees` or `rd " C- mea ru 5 l=`.
 * Real rules text is overwhelmingly letters, digits and ordinary punctuation.
 */
export function stripNoise(text) {
    return text.split('\n').map((l) => l.trim()).filter(isCardText).join('\n').trim();
}
/**
 * Distinguish a real line of rules text from OCR'd frame/art.
 *
 * A symbol-ratio test alone is not enough — noise like `UD Vl IED 1 1
 * iEcEudcsuUd. Oise an Ln` is mostly alphanumeric and slips through. What
 * separates it from real text is shape: noise fragments into many 1-2 character
 * tokens and produces words with uppercase letters buried mid-word.
 */
function isCardText(line) {
    if (!line)
        return false;
    const alnum = (line.match(/[A-Za-z0-9]/g) ?? []).length;
    if (alnum < 3)
        return false;
    const legible = (line.match(/[A-Za-z0-9 .,'"()\-:;!?%+/]/g) ?? []).length;
    if (legible / line.length < 0.85 || alnum / line.length < 0.5)
        return false;
    const words = line.split(/\s+/).filter(Boolean);
    if (words.length === 0)
        return false;
    // Noise shatters into stubs; real sentences rarely exceed ~40% short words.
    const stubs = words.filter((w) => w.replace(/[^A-Za-z0-9]/g, '').length <= 2).length;
    if (stubs / words.length > 0.55)
        return false;
    // "iEcEudcsuUd" — a capital appearing after a lowercase inside one word.
    const scrambled = words.filter((w) => /[a-z][A-Z]/.test(w)).length;
    if (scrambled > 1)
        return false;
    // Real text has vowels; garbage strings of consonants do not.
    const wordy = words.filter((w) => /[aeiouAEIOU]/.test(w)).length;
    return wordy / words.length >= 0.4;
}
export function guessType(typeLineText) {
    const t = correct(typeLineText).toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ');
    const has = (w) => t.includes(w);
    // Order matters: compound types before the bare "combat".
    if (has('physical') && has('combat'))
        return { type: 'Physical Combat', conf: 'match' };
    if (has('energy') && has('combat'))
        return { type: 'Energy Combat', conf: 'match' };
    if ((has('non') || has('non-')) && has('combat'))
        return { type: 'Non-Combat', conf: 'match' };
    if (has('dragon') && has('ball'))
        return { type: 'Dragon Ball', conf: 'match' };
    if (has('battleground') || has('location'))
        return { type: 'Location', conf: 'match' };
    for (const ct of ['Drill', 'Mastery', 'Sensei', 'Combat']) {
        if (has(ct.toLowerCase()))
            return { type: ct, conf: 'match' };
    }
    return { type: null, conf: 'none' };
}
/** Parse the scouter digit ladder into power ratings (stage 0 first). */
export function parseLadder(text) {
    const lines = text
        .split('\n')
        .map((l) => l.replace(/[^0-9Z]/gi, '').trim())
        .filter(Boolean);
    const ratings = [];
    for (const l of lines) {
        if (/^Z+$/i.test(l))
            ratings.push('Z');
        else {
            const n = Number(l);
            if (Number.isFinite(n))
                ratings.push(n);
        }
    }
    // Printed top(highest) -> bottom(0); reverse to stage 0..N.
    ratings.reverse();
    // A scouter ladder is strictly increasing by construction, so any value that
    // breaks that ordering is a misread. Keep the longest increasing run and
    // report what was dropped rather than silently trusting a corrupt ladder.
    const repaired = longestIncreasing(ratings);
    const dropped = ratings.length - repaired.length;
    const suspect = repaired.length < 3 || dropped > 0;
    return { ratings: repaired, suspect, dropped };
}
/**
 * Longest strictly-increasing subsequence, preserving 'Z' entries (which sit
 * outside the numeric ordering — see the CRD's Z power-stage personalities).
 */
function longestIncreasing(ratings) {
    const zs = ratings.filter((r) => r === 'Z');
    const nums = ratings.filter((r) => typeof r === 'number');
    if (nums.length === 0)
        return ratings;
    const best = [];
    for (const n of nums) {
        let lo = 0;
        let hi = best.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (best[mid].at(-1) < n)
                lo = mid + 1;
            else
                hi = mid;
        }
        const prev = lo > 0 ? best[lo - 1] : [];
        best[lo] = [...prev, n];
    }
    return [...zs, ...(best.at(-1) ?? [])];
}
//# sourceMappingURL=shared.js.map