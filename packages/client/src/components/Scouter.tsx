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
import { bracketLetterOf } from '@dbz/engine';

export interface ScouterProps {
  personality: PersonalityInPlay;
  /** Total stages on the current level card, for the pip track. */
  stageCount?: number;
  compact?: boolean;
}

const HEX = 'M12 2 L21 7 L21 17 L12 22 L3 17 L3 7 Z';

function formatRating(rating: number | 'Z'): string {
  if (rating === 'Z') return 'Z';
  return rating.toLocaleString('en-US');
}

export function Scouter({ personality, stageCount = 11, compact = false }: ScouterProps) {
  const villain = personality.alignment === 'Villain';
  const letter = bracketLetterOf(personality.currentRating);
  const atZero = personality.stageIndex <= 0;
  const pips = Math.max(stageCount, personality.stageIndex + 1);

  return (
    <div className={`scouter ${villain ? 'scouter--villain' : 'scouter--hero'} ${compact ? 'scouter--compact' : ''}`}>
      <svg viewBox="0 0 240 120" role="img" aria-label={`Power ${formatRating(personality.currentRating)}, bracket ${letter}, stage ${personality.stageIndex}`}>
        <defs>
          <linearGradient id="lensGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--lens-hi)" />
            <stop offset="100%" stopColor="var(--lens-lo)" />
          </linearGradient>
          <pattern id="hexes" width="24" height="21" patternUnits="userSpaceOnUse" patternTransform="scale(0.6)">
            <path d={HEX} fill="none" stroke="var(--lens-mesh)" strokeWidth="1" />
          </pattern>
          <filter id="lensGlow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Angular lens body */}
        <path
          className="scouter__lens"
          d="M18 10 L206 10 L232 34 L232 86 L206 110 L18 110 L6 86 L6 34 Z"
          fill="url(#lensGrad)"
          stroke="var(--lens-edge)"
          strokeWidth="2"
        />
        <path
          d="M18 10 L206 10 L232 34 L232 86 L206 110 L18 110 L6 86 L6 34 Z"
          fill="url(#hexes)"
          opacity="0.5"
        />

        {/* Bracket letter — the value combat is actually read from */}
        <text className="scouter__bracket" x="46" y="74" textAnchor="middle" filter="url(#lensGlow)">
          {letter}
        </text>
        <text className="scouter__bracketLabel" x="46" y="94" textAnchor="middle">
          PAT
        </text>

        {/* Exact rating */}
        <text className="scouter__rating" x="216" y="58" textAnchor="end">
          {formatRating(personality.currentRating)}
        </text>
        <text className="scouter__stage" x="216" y="80" textAnchor="end">
          STAGE {personality.stageIndex}
        </text>

        {/* Power-stage pips along the lower arc */}
        <g className="scouter__pips">
          {Array.from({ length: pips }, (_, i) => (
            <rect
              key={i}
              x={88 + i * 11}
              y={94}
              width={7}
              height={8}
              rx={1.5}
              className={i <= personality.stageIndex ? 'pip pip--lit' : 'pip'}
            />
          ))}
        </g>

        {/* Cracked lens at stage 0 */}
        {atZero && (
          <g className="scouter__crack">
            <path d="M60 12 L96 54 L74 62 L120 108" />
            <path d="M96 54 L150 40" />
            <path d="M120 108 L160 76 L206 88" />
          </g>
        )}
      </svg>
    </div>
  );
}
