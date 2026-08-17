/** Card database: indexes enriched card data for the engine (injected, no I/O here). */
import type { Ability, Alignment, PowerRating } from '@dbz/shared';

export interface EnginePersonality {
  level: number;
  personalityName: string;
  alignment: Alignment;
  powerRatings: PowerRating[];
  zeroStageIndex: number;
  pur: number | null;
  canBeAlly: boolean;
  canCaptureDragonBall?: boolean;
  variant?: string;
}

export interface EngineCardRules {
  type: string;
  coverage: string;
  text?: string;
  needsReview?: string[];
  /** Ruling note carried on the card by the TTS mod author. */
  errata?: string;
  /** True when two independent sources agree on the text, or vision read it. */
  textVerified?: boolean | string;
  /** Endurance value printed at the start of the rules text (CRD ~L1118). */
  endurance?: number;
  personality?: EnginePersonality;
  abilities?: Ability[];
}

export interface EngineCard {
  id: string;
  number: number | null;
  name: string;
  style: string | null;
  saga: string;
  rarity: string;
  imageUrl: string;
  rules?: EngineCardRules;
}

export class CardDb {
  private byId = new Map<string, EngineCard>();

  constructor(cards: EngineCard[]) {
    for (const c of cards) this.byId.set(c.id, c);
  }

  get(id: string): EngineCard | undefined {
    return this.byId.get(id);
  }

  personality(id: string): EnginePersonality | undefined {
    return this.byId.get(id)?.rules?.personality;
  }

  type(id: string): string {
    return this.byId.get(id)?.rules?.type ?? 'Unknown';
  }

  /** All personality level cards for a character name (level 1..N), sorted by level. */
  levelsOf(personalityName: string): EngineCard[] {
    return [...this.byId.values()]
      .filter((c) => c.rules?.personality?.personalityName === personalityName)
      .sort((a, b) => (a.rules!.personality!.level - b.rules!.personality!.level));
  }
}
