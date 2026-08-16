export type Rect = {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
};
/**
 * Regions as fractions of the card face.
 *
 * Calibrated against 800x1100 TTS slices by cropping and inspecting. The
 * earlier values clipped real content: `powerColumn` cut the leading digit off
 * every rating ("...,000,000" instead of "2,000,000"), `textBox` cut the right
 * edge off every line, and `powerText` truncated the last two lines of ability
 * text. Widen with care and re-inspect crops before trusting a change.
 */
export declare const REGIONS: {
    title: {
        x0: number;
        y0: number;
        x1: number;
        y1: number;
    };
    typeLine: {
        x0: number;
        y0: number;
        x1: number;
        y1: number;
    };
    textBox: {
        x0: number;
        y0: number;
        x1: number;
        y1: number;
    };
    powerColumn: {
        x0: number;
        y0: number;
        x1: number;
        y1: number;
    };
    pur: {
        x0: number;
        y0: number;
        x1: number;
        y1: number;
    };
    level: {
        x0: number;
        y0: number;
        x1: number;
        y1: number;
    };
    powerText: {
        x0: number;
        y0: number;
        x1: number;
        y1: number;
    };
};
export declare function correct(text: string): string;
export declare function px(rect: Rect, w: number, h: number): {
    left: number;
    top: number;
    width: number;
    height: number;
};
/**
 * How a region's pixels are prepared for Tesseract. This is about contrast
 * polarity, NOT about whether the content is numeric:
 *
 *  - 'invert' — light glyphs on a dark/saturated fill (the scouter ladder's
 *    white digits on red pills). Threshold keeps the bright glyphs, negate
 *    turns them into black-on-white.
 *  - 'text'   — dark glyphs on a light fill (rules text, and the PUR and level
 *    badges, which are red digits on green). Thresholding these destroys them:
 *    red (~80 luma) and green (~150) both fall below the cut and flatten to a
 *    single blank field, which is why PUR read as 0 for every personality.
 */
export type Preprocess = 'text' | 'invert';
export declare function regionBuffer(path: string, rect: Rect, w: number, h: number, opts?: {
    mode?: Preprocess;
}): Promise<Buffer>;
/**
 * Drop OCR lines that are frame/art noise rather than card text.
 *
 * Even a well-placed crop catches a sliver of border or flavour text, which
 * Tesseract renders as things like `NY 8 WW AY Gees` or `rd " C- mea ru 5 l=`.
 * Real rules text is overwhelmingly letters, digits and ordinary punctuation.
 */
export declare function stripNoise(text: string): string;
export declare function guessType(typeLineText: string): {
    type: string | null;
    conf: 'match' | 'none';
};
/** Parse the scouter digit ladder into power ratings (stage 0 first). */
export declare function parseLadder(text: string): {
    ratings: Array<number | 'Z'>;
    suspect: boolean;
    dropped: number;
};
export interface OcrRecord {
    id: string;
    number: number | null;
    name: string;
    saga?: string;
    /** Raw unfiltered OCR of the rules area (input to offline correction). */
    textRaw?: string;
    /** Per-word text/confidence/row for offline threshold tuning. */
    words?: Array<{
        t: string;
        c: number;
        y: number;
    }>;
    isPersonality: boolean;
    personalityName?: string;
    level?: number;
    variant?: string;
    type: string | null;
    typeLineRaw?: string;
    text?: string;
    powerRatings?: Array<number | 'Z'>;
    pur?: number | null;
    levelNum?: number | null;
    confidence: Record<string, number>;
    needsReview: string[];
}
//# sourceMappingURL=shared.d.ts.map