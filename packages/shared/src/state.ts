/** Game state for the DBZ CCG engine. See docs/RULES-NOTES.md. */
import type { Alignment, PowerRating, Style } from './cards.js';
import type { Effect } from './abilities.js';

/** The 7 steps of the Sequence of Play (CRD ~L214). */
export const STEPS = [
  'draw',
  'nonCombat',
  'powerUp',
  'declare',
  'combat',
  'discard',
  'rejuvenation',
] as const;
export type Step = (typeof STEPS)[number];

/** Player-owned zones. */
export const ZONES = [
  'lifeDeck',
  'hand',
  'discard',
  'inPlay', // Drills, Non-Combat in play, Locations, Masteries, Dragon Balls held
  'removed',
  'sensei',
] as const;
export type Zone = (typeof ZONES)[number];

/** A physical card in a game, referencing catalog data by cardId. */
export interface CardInstance {
  /** Unique instance id within the game. */
  uid: string;
  /** Reference into the card catalog (Card.id). */
  cardId: string;
  /** Face-down (e.g. Life Deck, set cards). */
  faceDown: boolean;
  /** Revealed while face-down (peeked/searched). */
  revealed?: boolean;
  /** Cards attached beneath this one (CRD "Attaching a Card"). */
  attached?: CardInstance[];
  /** Arbitrary per-instance counters/flags set by effects. */
  counters?: Record<string, number>;
}

/** One personality "stack" — the MP's levels, or an Ally. */
export interface PersonalityInPlay {
  uid: string;
  personalityName: string;
  alignment: Alignment;
  /** Ordered level cards (level 1 first). For an Ally usually a single level. */
  levelCardIds: string[];
  /** Current active level (1-based). */
  currentLevel: number;
  /**
   * Scouter position: index into the current level card's power ratings array
   * = the current power stage. "5 above 0" at start = zeroStageIndex + 5.
   */
  stageIndex: number;
  /** Cached rating at stageIndex (number | 'Z') for convenience/UI. */
  currentRating: PowerRating;
  /** Anger 0..5 (MP only; advances at 5). */
  anger: number;
  /** True for an Ally (vs. the Main Personality). */
  isAlly: boolean;
  /**
   * Turn number on which this personality last used its Personality Power.
   *
   * "A Personality Power ... is only used once per turn ... unless the
   * character advances or loses a Personality level. When this happens you get
   * to use the card effect again even if you used it earlier this turn"
   * (CRD ~L492) — which is why this is a turn number cleared on a level change
   * rather than a boolean cleared only at end of turn.
   */
  usedPowerTurn?: number;
  /** True while this personality is in Control of Combat. */
  inControlOfCombat?: boolean;
}

export interface PlayerState {
  idx: number;
  name: string;
  connected: boolean;
  alignment: Alignment;
  style?: Style;
  /** Declared Tokui-Waza style, if any. Absent for a Freestyle Tokui-Waza. */
  tokuiWaza?: Style;
  /**
   * True when a Tokui-Waza was declared at setup. Distinct from `tokuiWaza`
   * because a Freestyle declaration grants the same +1 PUR and Endurance
   * access without naming a Style.
   */
  tokuiWazaDeclared?: boolean;
  masteryCardId?: string;
  senseiCardId?: string;
  /** The Main Personality. */
  mp: PersonalityInPlay;
  /** Allies currently in play. */
  allies: PersonalityInPlay[];
  zones: Record<Zone, CardInstance[]>;
  /** Dragon Balls this player currently controls (own or captured). */
  dragonBalls: CardInstance[];
  /** True once this player has loaded their deck and is ready. */
  ready: boolean;
}

export type AttackType = 'physical' | 'energy';

export interface AttackInProgress {
  /** The player performing THIS attack (the phase player), and their target. */
  attackerPlayerIdx: number;
  defenderPlayerIdx: number;
  /** Personality in Control of Combat for each side. */
  attackerControllerUid: string;
  defenderControllerUid: string;
  cardUid?: string;
  attackType: AttackType;
  stopped: boolean;
  successful: boolean;
  empower?: number;
  baseDamage?: number;
  /** Unconditional damage modifiers (power stages). */
  modifiers?: number;
  /** Unconditional damage modifiers (life cards) — the mirror of `modifiers`. */
  lifeCardModifiers?: number;
  /** Additional power stages applied only if the attack is successful. */
  ifSuccessfulStages?: number;
  /** Additional life cards applied only if the attack is successful. */
  ifSuccessfulLifeCards?: number;
  /** Life cards an energy attack deals (default 4). */
  energyLifeCards?: number;
  /** Life cards a PHYSICAL attack deals when it specifies a fixed life-card amount
   *  (overrides PAT power-stage damage). */
  damageLifeCards?: number;
  /** Non-damage "if successful" effects still to run on success. */
  ifSuccessfulEffects?: Effect[];
  /**
   * Life cards of damage prevented by the defence (CRD ~L340 step 8).
   *
   * Prevention is NOT a stop: "an attack is considered successful even if it
   * deals no damage". A prevent-N card that cancels the attack instead robs the
   * attacker of the success itself — the capture, and every "if successful"
   * rider on the card they spent.
   */
  preventedLifeCards?: number;
  /** Life cards actually dealt so far by this attack (drives capture). */
  lifeCardsDealt?: number;
  /** Life-card damage still owed, paused while an Endurance prompt resolves. */
  pendingLifeCardDamage?: number;
  /**
   * Life cards this attack owes from the CARD (step 13), worked out at step 10
   * and carried across the power-stage damage at step 12 — an attack can deal
   * both resources, and the stages have to land first.
   */
  lifeCardsOwed?: number;
  /** The Endurance card currently offered to the defender. */
  enduranceOffer?: { uid: string; cardId: string; value: number; remaining: number };
  /** Power-stage damage awaiting redirect/application (physical). */
  pendingPowerStageDamage?: number;
  /**
   * Power stages the target could actually lose. Damage beyond the stages a
   * personality has left converts to life cards (CRD ~L422, ~L436), so an
   * attack can deal both kinds at once and the report has to carry both.
   */
  powerStagesDealt?: number;
  /** Which of the 16 battle-sequence steps we are on (1..16). */
  resolutionStep: number;
}

/**
 * The CRD's own numbered Battle Sequence (~L316-L364), for display.
 *
 * The sequence is the game's answer to "who can respond, and when" — the same
 * job a priority stack does elsewhere. Showing which step an attack has reached
 * turns that from something you have to know into something you can read.
 * Steps the engine does not implement are still listed, because a gap you can
 * see is better than a gap you cannot.
 */
export const BATTLE_SEQUENCE: Record<number, string> = {
  1: 'attacker plays a card',
  2: 'costs and Empower',
  3: "attacker's secondary effects",
  4: 'defender names Control of Combat',
  5: 'defender may defend',
  6: "defender's secondary effects",
  7: 'Defense Shields',
  8: 'the attack is successful',
  9: 'Base Damage',
  10: 'damage modifiers',
  11: 'Personality Capture',
  12: 'power stages dealt',
  13: 'life cards dealt — Endurance',
  14: 'Dragon Ball capture',
  15: '"If successful" effects',
  16: 'the attack card is discarded',
}

export interface CombatState {
  /** Active player for the turn (primary attacker). */
  attackerPlayerIdx: number;
  defenderPlayerIdx: number;
  /** Whose Attack Phase it currently is (alternates each phase). */
  phasePlayerIdx: number;
  /** Consecutive passes across both players; 2 ends the Combat Step. */
  consecutivePasses: number;
  /** Player idxs who have used their Final Physical Attack this combat. */
  finalUsed: number[];
  /**
   * Attack types a player may not perform for the REMAINDER of this combat,
   * from cards like "stops all energy attacks for the rest of this combat".
   * Cleared automatically when the Combat Step ends, since `combat` is dropped.
   */
  lockouts?: Array<{ playerIdx: number; attackType: 'physical' | 'energy' | 'any' }>;
  /** Defense Shields already spent this combat: each stops only the FIRST
   *  unstopped attack of its type (CRD ~L337). */
  shieldsUsed?: string[];
  currentAttack?: AttackInProgress;
}

/** A decision the engine needs from a specific player. */
export interface Prompt {
  id: string;
  playerIdx: number;
  type: string; // e.g. 'defend' | 'redirect' | 'capture' | 'empower' | 'chooseFirst'
  message: string;
  /** Choice options (cards, amounts, targets), shape depends on type. */
  options?: unknown[];
  optional?: boolean;
}

export type VictoryType = 'survival' | 'dragonBall' | 'mostPowerful' | 'concede';

export interface GameState {
  /** Deterministic RNG seed (games are replayable from actions + seed). */
  seed: number;
  phase: 'setup' | 'playing' | 'ended';
  turnNumber: number;
  activePlayerIdx: number;
  step: Step;
  players: PlayerState[];
  combat?: CombatState;
  /** Outstanding decision, if the engine is waiting on a player. */
  pendingPrompt?: Prompt;
  /**
   * Set when a Location/Battleground entered play this turn: the active player
   * must skip the Combat Step (CRD ~L233, ~L713). Cleared on the next turn.
   */
  skipCombatThisTurn?: boolean;
  /**
   * The Declare Step decision (CRD ~L232): did the attacker declare Combat this
   * turn? `false` sends them straight to the Discard Step and earns the
   * Rejuvenation Step's card back; `undefined` means they have not decided yet.
   * Cleared on the next turn.
   */
  declaredCombat?: boolean;
  /** Set once the active player has powered up this turn, so the Power-Up Step
   *  cannot be replayed to sit at the top of the ladder every turn. */
  poweredUpThisTurn?: boolean;
  /** Human-readable event log. */
  log: string[];
  /**
   * Seat with a Dragon Ball victory pending. Capturing the 7th ball FROM an
   * opponent does not win until the start of the capturer's next turn
   * (CRD §"Dragon Ball Victory"), and only if the set is still intact then.
   */
  pendingDragonVictory?: number;
  winnerIdx?: number;
  victoryType?: VictoryType;
}
