/**
 * Anger Sword — the 0..5 anger gauge.
 *
 * A Z-Sword silhouette that charges with ki from hilt to tip: five segments,
 * each a flame lick rather than a battery bar. At 5 the blade ignites and the
 * engine advances the personality a level (anger then resets to 0 per the CRD)
 * — this widget only reflects that, it never decides it.
 */
import type { PersonalityInPlay } from '@dbz/shared';
export interface AngerSwordProps {
    personality: PersonalityInPlay;
    /** Anger required to advance; 5 in the base rules. */
    threshold?: number;
}
export declare function AngerSword({ personality, threshold }: AngerSwordProps): import("react").JSX.Element;
//# sourceMappingURL=AngerSword.d.ts.map