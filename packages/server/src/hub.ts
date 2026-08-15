/** Room registry: code normalization, creation on demand, and idle reaping. */
import type { CardDb } from '@dbz/engine';
import { Room, type RoomOptions } from './room.js';

/** No I/O/1/0 — room codes get read aloud. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;

/** How long an empty room is kept alive so players can reconnect. */
export const ROOM_TTL_MS = 10 * 60 * 1000;

export function normalizeCode(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

export class Hub {
  private readonly rooms = new Map<string, Room>();

  constructor(
    private readonly db: CardDb,
    private readonly defaults: Omit<RoomOptions, 'db'> = {},
  ) {}

  get size(): number {
    return this.rooms.size;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(normalizeCode(code));
  }

  /** Joining an unused code creates that room — no separate "create" step. */
  getOrCreate(code: string): Room {
    const normalized = normalizeCode(code) || this.freshCode();
    const existing = this.rooms.get(normalized);
    if (existing) return existing;
    const room = new Room(normalized, { db: this.db, ...this.defaults });
    this.rooms.set(normalized, room);
    return room;
  }

  private freshCode(): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('could not allocate a free room code');
  }

  /** Drop rooms that have had no connections for longer than the TTL. */
  sweep(now = Date.now(), ttlMs = ROOM_TTL_MS): number {
    let removed = 0;
    for (const [code, room] of this.rooms) {
      if (room.clientCount === 0 && room.emptySince !== undefined && now - room.emptySince > ttlMs) {
        this.rooms.delete(code);
        removed++;
      }
    }
    return removed;
  }
}
