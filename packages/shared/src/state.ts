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
  /** Additional power stages applied only if the attack is successful. */
  ifSuccessfulStages?: number;
  /** Life cards an energy attack deals (default 4). */
  energyLifeCards?: number;
  /** Life cards a PHYSICAL attack deals when it specifies a fixed life-card amount
   *  (overrides PAT power-stage damage). */
  damageLifeCards?: number;
  /** Non-damage "if successful" effects still to run on success. */
  ifSuccessfulEffects?: Effect[];
  /** Power-stage damage awaiting redirect/application (physical). */
  pendingPowerStageDamage?: number;
  /** Which of the 16 battle-sequence steps we are on (1..16). */
  resolutionStep: number;
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
