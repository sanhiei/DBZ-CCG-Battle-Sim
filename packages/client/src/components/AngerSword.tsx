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

/** Segment bands up the blade, hilt (bottom) first. */
const BANDS = [
  { y: 150, h: 26 },
  { y: 122, h: 26 },
  { y: 94, h: 26 },
  { y: 66, h: 26 },
  { y: 38, h: 26 },
];

export function AngerSword({ personality, threshold = 5 }: AngerSwordProps) {
  const anger = Math.max(0, Math.min(personality.anger, threshold));
  const ignited = anger >= threshold;
  const villain = personality.alignment === 'Villain';

  return (
    <div className={`anger ${ignited ? 'anger--ignited' : ''} ${villain ? 'anger--villain' : 'anger--hero'}`}>
      <svg viewBox="0 0 84 210" role="img" aria-label={`Anger ${anger} of ${threshold}`}>
        <defs>
          <clipPath id="bladeClip">
            {/* Blade silhouette: tapered point, broad ricasso */}
            <path d="M42 6 L56 40 L56 168 L42 178 L28 168 L28 40 Z" />
          </clipPath>
          <linearGradient id="kiGrad" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="var(--ki-lo)" />
            <stop offset="100%" stopColor="var(--ki-hi)" />
          </linearGradient>
          <filter id="kiGlow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="2.6" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Blade body */}
        <path className="anger__blade" d="M42 6 L56 40 L56 168 L42 178 L28 168 L28 40 Z" />

        {/* Ki charge, clipped to the blade */}
        <g clipPath="url(#bladeClip)">
          {BANDS.map((band, i) => (
            <g key={i} className={i < anger ? 'seg seg--lit' : 'seg'}>
              <rect x="26" y={band.y} width="32" height={band.h - 4} fill="url(#kiGrad)" />
              {/* flame lick along the segment's upper edge */}
              <path
                d={`M26 ${band.y} q8 -7 16 0 q8 7 16 0 v6 h-32 z`}
                fill="url(#kiGrad)"
                opacity="0.85"
              />
            </g>
          ))}
        </g>

        {/* Fuller line + hilt */}
        <path className="anger__fuller" d="M42 20 L42 170" />
        <path className="anger__guard" d="M14 178 h56 v9 h-56 z" />
        <path className="anger__grip" d="M36 187 h12 v18 h-12 z" />

        {/* Ignition aura at threshold */}
        {ignited && (
          <path
            className="anger__aura"
            d="M42 2 L60 38 L60 170 L42 182 L24 170 L24 38 Z"
            filter="url(#kiGlow)"
          />
        )}

        <text className="anger__count" x="42" y="205" textAnchor="middle">
          {anger}/{threshold}
        </text>
      </svg>
    </div>
  );
}
