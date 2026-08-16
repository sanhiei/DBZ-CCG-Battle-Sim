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
export declare function splitSentences(text: string): string[];
export declare function normalizeKey(sentence: string): string;
/** Mine templates from a corpus of card texts. */
export declare function mineTemplates(texts: string[], minCount?: number): Template[];
/** Levenshtein with a band cutoff; returns Infinity when > maxDist. */
export declare function editDistance(a: string, b: string, maxDist: number): number;
export interface SnapResult {
    text: string;
    snapped: boolean;
    template?: Template;
}
/**
 * Snap one sentence to the closest template if similarity clears `minRatio`.
 * Digits from the INPUT sentence are re-slotted into the template.
 */
export declare function snapSentence(sentence: string, templates: Template[], minRatio?: number): SnapResult;
/** Correct a whole card text; returns the text plus how many sentences snapped. */
export declare function correctText(text: string, templates: Template[], minRatio?: number): {
    text: string;
    snappedCount: number;
};
//# sourceMappingURL=phrases.d.ts.map