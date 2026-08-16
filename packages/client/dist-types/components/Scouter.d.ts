/**
 * Scouter — power readout for one personality.
 *
 * A Ginyu-era HUD lens rather than a literal 3D scouter: hex-tessellated glass,
 * teal for Heroes and crimson for Villains. The focal glyph is the PAT bracket
 * LETTER, because that is what a physical attack actually reads; the exact
 * rating sits beneath it, and the power stages run as pips along the lens arc.
 *
 * Renders engine truth only — it never computes a rule. At stage 0 the lens
 * cracks, which is both the nod and a legibility cue that the personality is
 * one hit from losing the game.
 */
import type { PersonalityInPlay } from '@dbz/shared';
export interface ScouterProps {
    personality: PersonalityInPlay;
    /** Total stages on the current level card, for the pip track. */
    stageCount?: number;
    compact?: boolean;
}
export declare function Scouter({ personality, stageCount, compact }: ScouterProps): import("react").JSX.Element;
//# sourceMappingURL=Scouter.d.ts.map