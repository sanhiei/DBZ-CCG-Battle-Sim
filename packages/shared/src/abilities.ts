/**
 * Machine-readable card abilities — the data the engine executes to automate a
 * card's effect. Authored/parsed from card rules text and verified against the
 * CRD. Cards start with a `manual` effect (resolve as a tabletop action) and gain
 * modeled effects as coverage grows.
 */

export type AbilityTrigger =
  | 'attack' // performed in an Attack Phase (an attack + riders)
  | 'defense' // used to defend (starburst)
  | 'onPlay' // Non-Combat: on play/use
  | 'personalityPower' // Combat Step, once per turn (unless noted)
  | 'whenEnteringCombat'
  | 'constant'; // Drills / continuous

export type EffectTarget = 'user' | 'foe';
export type AttackKind = 'physical' | 'energy';

/**
 * A single game effect. `ifSuccessful` effects apply only after the attack is
 * successful (CRD battle-sequence step 15); others are secondary (immediate).
 */
export type Effect =
  // Attacks. Base Damage defaults: physical => PAT power stages; energy => 4 life
  // cards. If `lifeCards`/`powerStages` is set, that fixed amount OVERRIDES the
  // default (e.g. "Physical attack causing 1 life card of damage").
  | { kind: 'physicalAttack'; lifeCards?: number; powerStages?: number }
  | { kind: 'energyAttack'; lifeCards?: number; powerStages?: number }
  | { kind: 'damageStages'; stages: number; ifSuccessful?: boolean } // +/- modifier on PAT
  /** `toZero` sets anger to 0 outright ('lower your anger to 0'); a delta of
   *  0 would otherwise be a silent no-op that still looks modelled. */
  | { kind: 'changeAnger'; target: EffectTarget; delta: number; toZero?: boolean }
  | { kind: 'changePowerStages'; target: EffectTarget; delta: number; toZero?: boolean }
  | { kind: 'movePowerStage'; target: EffectTarget; to: 'highest' | 'lowest' }
  // Defensive: stop an attack, or prevent some of its life-card damage.
  | {
      kind: 'stopAttack';
      attackType?: AttackKind | 'any';
      /** thisAttack = the current one; nextPhase = foe's next; thisCombat = all
       *  such attacks this combat; firstSuccessful = the first that gets through. */
      window?: 'thisAttack' | 'nextPhase' | 'thisCombat' | 'firstSuccessful';
      scope?: 'all' | 'single';
    }
  | { kind: 'preventLifeCards'; amount: number; attackType?: AttackKind | 'any' }
  | { kind: 'drawCards'; count: number }
  /**
   * Rejuvenation: move cards from the discard pile to the BOTTOM of the Life
   * Deck. `from` is which end of the discard pile they come off; "choose" means
   * the player picks, which the engine currently resolves as the bottom-most
   * cards and flags for review rather than prompting.
   */
  | { kind: 'rejuvenate'; count: number; from: 'bottom' | 'top' | 'choose' }
  /** Discard from hand — as a cost (`user`) or as an effect on the opponent. */
  | { kind: 'discardCards'; target: EffectTarget; count: number }
  | { kind: 'stunSkipNextPhase' }
  | { kind: 'removeFromGameAfterUse' }
  | { kind: 'manual'; note?: string }; // not yet modeled — resolve manually

export interface AbilityCost {
  powerStages?: number;
  discard?: number;
}

export interface AbilityRestriction {
  alignment?: 'Hero' | 'Villain';
  /** Only these named personalities may use it (e.g. "Villains, Goku, and Gohan only"). */
  namedOnly?: string[];
}

export interface Ability {
  trigger: AbilityTrigger;
  label?: string;
  cost?: AbilityCost;
  restriction?: AbilityRestriction;
  effects: Effect[];
  /** 'parsed' = auto-derived (verify); 'authored' = hand-verified. */
  source?: 'parsed' | 'authored';
  /** Fields the parser was unsure about (for QA). */
  needsReview?: string[];
}
