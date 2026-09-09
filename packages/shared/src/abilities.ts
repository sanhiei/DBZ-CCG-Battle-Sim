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
  /**
   * A signed LIFE-CARD amount on an attack ("+2 life cards of damage").
   *
   * The mirror of damageStages, and it did not exist: the parser recognised the
   * shape, set a bare boolean flag that no Effect could carry, and flagged the
   * ability for review. The printed amount was never dealt. CRD ~L436 is
   * explicit that a modifier lands "even if the attack doesn't deal the kind of
   * damage that is being modified", so this rides on physical attacks too.
   */
  | { kind: 'damageLifeCards'; cards: number; ifSuccessful?: boolean }
  /**
   * A Card Capture (CRD ~L682): "Some cards allow for the capture of Dragon
   * Balls." Distinct from the life-card capture, which is earned by dealing 5+,
   * and from the Personality Capture Rule, which is a named Ally trading its
   * damage for a ball.
   */
  | { kind: 'captureDragonBall'; ifSuccessful?: boolean }
  /**
   * A continuous damage modifier from a card ON THE TABLE — a Drill, a
   * Location, a Battleground, a Dragon Ball you control. Battle-sequence step
   * 10 adds "any modifiers, from the attack, Drills, personality powers, etc."
   * and only the attack's own were ever added: no code anywhere read either
   * player's inPlay to change damage, so every one of these was inert in both
   * directions.
   *
   * `applies` is whose attacks it touches, from the card's own wording:
   *   yours      - "All of your physical attacks do +2 power stages"
   *   againstYou - "All energy attacks performed against you do 1 less"
   *   all        - "All physical attacks do +1" (Locations, which are neutral)
   */
  | {
      kind: 'constantDamageModifier';
      amount: number;
      resource: 'stages' | 'lifeCards';
      attackType: AttackKind | 'any';
      applies: 'yours' | 'againstYou' | 'all';
    }
  /** `toZero` sets anger to 0 outright ('lower your anger to 0'); a delta of
   *  0 would otherwise be a silent no-op that still looks modelled.
   *
   *  `ifSuccessful` defers the effect until the attack is known to have landed.
   *  CRD battle-sequence step 3 resolves secondary effects at DECLARATION but
   *  explicitly excludes "If successful" effects and effects sharing a sentence
   *  with the attack — without this flag those all fired before the defender
   *  had even been offered their defence. */
  | { kind: 'changeAnger'; target: EffectTarget; delta: number; toZero?: boolean; ifSuccessful?: boolean }
  | {
      kind: 'changePowerStages';
      target: EffectTarget;
      delta: number;
      toZero?: boolean;
      ifSuccessful?: boolean;
      /**
       * The card says "to a minimum of 0", so the loss simply stops there.
       * Without it, CRD ~L390 applies: "if you go below 0, you must discard the
       * top card of your life deck for every power stage left over."
       */
      minimumZero?: boolean;
    }
  | { kind: 'movePowerStage'; target: EffectTarget; to: 'highest' | 'lowest'; ifSuccessful?: boolean }
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
  | { kind: 'drawCards'; count: number; ifSuccessful?: boolean }
  /**
   * Rejuvenation: move cards from the discard pile to the BOTTOM of the Life
   * Deck. `from` is which end of the discard pile they come off; "choose" means
   * the player picks, which the engine currently resolves as the bottom-most
   * cards and flags for review rather than prompting.
   */
  | { kind: 'rejuvenate'; count: number; from: 'bottom' | 'top' | 'choose'; ifSuccessful?: boolean }
  /** Discard from hand — as a cost (`user`) or as an effect on the opponent. */
  | { kind: 'discardCards'; target: EffectTarget; count: number; ifSuccessful?: boolean }
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
  /**
   * Which side of Combat may use it. 30 "When entering Combat" cards fire only
   * for one role ("...as the defender"), and firing them for both would hand
   * the attacker an effect the card does not give them.
   */
  role?: 'attacker' | 'defender';
  /**
   * The card says "you may". Firing an optional effect automatically is not a
   * smaller bug than never firing it — it takes the decision away — so these
   * are offered rather than applied.
   */
  optional?: boolean;
  effects: Effect[];
  /** 'parsed' = auto-derived (verify); 'authored' = hand-verified. */
  source?: 'parsed' | 'authored';
  /** Fields the parser was unsure about (for QA). */
  needsReview?: string[];
}
