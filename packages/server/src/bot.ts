/**
 * A CPU opponent.
 *
 * It is a RoomClient like any other. It joins a seat, receives the same
 * REDACTED state a human gets — it cannot see your hand or your deck order —
 * and every action it sends goes through the same `authorize()` and the same
 * reducer. There is no privileged path, which is the point: a bot that cheated
 * through a back door would not test anything.
 *
 * The policy is the one from scripts/playthrough.mjs, which drives full 11-16
 * turn games without wedging. It plays competently enough to exercise the rules
 * and badly enough that nobody should be proud of beating it: it takes the
 * first legal option in most spots rather than evaluating any of them.
 */
import type { CardInstance, DeckList, GameState, ServerMessage } from '@dbz/shared';
import type { CardDb } from '@dbz/engine';
import type { Room, RoomClient } from './room.js';

/** Pause between bot actions, so a human can watch what it did. */
const THINK_MS = 450;

const CAN_ATTACK = (type: string): boolean => type === 'Unknown' || /combat/i.test(type);
const CAN_PLAY = new Set(['Non-Combat', 'Drill', 'Location', 'Battleground', 'Dragon Ball']);

/** What the bot answers when the engine asks it something. */
function answerFor(prompt: NonNullable<GameState['pendingPrompt']>, state: GameState): unknown {
  const options = Array.isArray(prompt.options) ? (prompt.options as Array<{ uid?: string }>) : [];
  const firstUid = options.length > 0 ? options[0]?.uid ?? null : null;
  switch (prompt.type) {
    case 'declareCombat':
      // Fight on even turns, rebuild on odd ones, so both branches of the
      // Declare Step get exercised across a game.
      return { declare: state.turnNumber % 2 === 0 };
    case 'discard':
      return { uid: firstUid };
    case 'rejuvenate':
      return { take: true };
    case 'prepareOptional':
      return { use: true };
    case 'defend':
      return { takeDamage: true };
    case 'endurance':
      return { use: false };
    case 'capture':
    case 'personalityCapture':
    case 'controlOfCombat':
      return { uid: firstUid };
    case 'redirect':
      return { toUid: null };
    default:
      return null;
  }
}

/**
 * The one action the bot wants to take right now, or null to sit still.
 *
 * Order matters: answer a question first, then act in Combat, then play a card
 * in the Non-Combat Step, then move the turn on.
 */
function decide(state: GameState, seat: number, db: CardDb): { type: string; [k: string]: unknown } | null {
  if (state.phase !== 'playing') return null;
  const me = state.players[seat];
  if (!me) return null;

  const prompt = state.pendingPrompt;
  if (prompt) {
    if (prompt.playerIdx !== seat) return null; // not ours to answer
    return { type: 'answerPrompt', promptId: prompt.id, choice: answerFor(prompt, state) };
  }

  const combat = state.combat;
  if (combat && combat.phasePlayerIdx === seat && !combat.currentAttack) {
    // A Personality Power is free, so try it before spending a card.
    const controller = me.allies.find((a) => a.inControlOfCombat) ?? me.mp;
    const powerCard = controller.levelCardIds[controller.currentLevel - 1];
    const hasPower =
      !!powerCard &&
      (db.get(powerCard)?.rules?.abilities ?? []).some((a) => a.trigger === 'personalityPower');
    if (hasPower && controller.usedPowerTurn !== state.turnNumber) {
      return { type: 'usePersonalityPower' };
    }
    const weapon = me.zones.hand.find((c: CardInstance) => CAN_ATTACK(db.type(c.cardId)));
    if (weapon) return { type: 'declareAttack', attackType: 'physical', cardUid: weapon.uid };
    const spare = me.zones.hand[0];
    if (spare && !combat.finalUsed.includes(seat)) {
      return { type: 'finalPhysicalAttack', discardUid: spare.uid };
    }
    return { type: 'pass' };
  }
  if (combat) return null; // the other seat is acting

  if (state.activePlayerIdx !== seat) return null;

  if (state.step === 'nonCombat') {
    const playable = me.zones.hand.find((c: CardInstance) => CAN_PLAY.has(db.type(c.cardId)));
    if (playable) return { type: 'playCard', playerIdx: seat, cardUid: playable.uid };
  }
  return { type: 'advanceStep' };
}

let botCounter = 0;

/**
 * Seat a bot in `room` and let it play. Returns its client id, or an error
 * when there is no free seat.
 */
export function addBot(
  room: Room,
  db: CardDb,
  deck: DeckList,
  name = 'CPU',
): { id: string } | { error: string } {
  botCounter += 1;
  const id = `bot-${botCounter}`;
  let seat: number | null = null;
  let busy = false;

  const act = (action: Record<string, unknown>): void => {
    room.handleAction(id, { ...action, clientActionId: `${id}-${botCounter}` } as never);
  };

  /**
   * Everything the bot does is deferred. The reducer runs inside handleAction,
   * which broadcasts, which lands back in send() — acting synchronously would
   * recurse. The delay also gives a human time to see what it did.
   */
  const later = (fn: () => void): void => {
    if (busy) return;
    busy = true;
    setTimeout(() => {
      busy = false;
      try {
        fn();
      } catch {
        // A bot that throws must not take the room down with it; it simply
        // misses this turn and tries again on the next broadcast.
      }
    }, THINK_MS);
  };

  const client: RoomClient = {
    id,
    send(msg: ServerMessage) {
      if (msg.kind === 'session') {
        seat = msg.playerIdx;
        return;
      }
      if (seat === null) return;

      if (msg.kind === 'lobby') {
        // LobbyView lists OCCUPIED seats only, so find ours by index rather
        // than indexing into the array. It reports a submitted deck as
        // `deckName`; there is no `deck` field, and looking for one meant the
        // bot re-sent loadDeck forever and never readied.
        const mine = msg.lobby.seats.find((s) => s.idx === seat);
        if (!mine || mine.ready) return;
        later(() => {
          if (seat === null) return;
          if (!mine.deckName) act({ type: 'loadDeck', playerIdx: seat, deck });
          else act({ type: 'setReady', playerIdx: seat });
        });
        return;
      }

      if (msg.kind !== 'state') return;
      // Deliberately the REDACTED copy from the broadcast, not room.gameState.
      // Reading the live state would let the bot see the opponent's hand and
      // deck order, and a bot that cheats through a back door tests nothing.
      // The cost is that this view is a few hundred ms stale by the time the
      // timer fires, which is harmless: an action that is no longer legal is
      // rejected by the same reducer that would reject a human's.
      const view = msg.state;
      later(() => {
        if (seat === null) return;
        const next = decide(view, seat, db);
        if (next) act(next);
      });
    },
  };

  const result = room.join({ client, playerName: name, spectate: false });
  if (result.seatIdx === null) {
    room.leave(id);
    return { error: 'no free seat for a CPU opponent' };
  }
  seat = result.seatIdx;
  // join() returns the seat rather than pushing a session message, so the
  // lobby step is primed here; every step after this is driven by broadcasts.
  later(() => seat !== null && act({ type: 'loadDeck', playerIdx: seat, deck }));
  return { id };
}
