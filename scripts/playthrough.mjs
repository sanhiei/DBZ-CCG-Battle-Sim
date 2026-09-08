/**
 * Drives a real game to its end with the real catalog and the built preset
 * decks, answering every prompt the engine raises.
 *
 * Unit tests use fixture cards and hand-built states; they cannot tell you
 * whether an actual game reaches turn 20 or wedges on a prompt nobody can
 * answer. This can. It is a smoke test for deadlock and for the turn loop
 * closing, not an assertion about any particular rule.
 *
 *   node scripts/playthrough.mjs [turns] [seed]
 */
import { readFileSync } from 'node:fs';
import { CardDb, createGame, reduce, setPatTable } from '../packages/engine/dist/index.js';

const TURNS = Number(process.argv[2] ?? 30);
const SEED = Number(process.argv[3] ?? 11);
/**
 * `peaceful` always declines Combat. Worth having, because in normal mode this
 * driver declares unlimited free attacks (an open finding: an attack needs no
 * card, no power stages and no cost) and every game ends on turn 2 by
 * Survival — which never exercises more than one Discard Step.
 */
const PEACEFUL = process.argv[4] === 'peaceful';

const cards = JSON.parse(readFileSync(new URL('../data/cards.tts.enriched.json', import.meta.url), 'utf8'));
const db = new CardDb(cards);

try {
  setPatTable(JSON.parse(readFileSync(new URL('../data/pat.json', import.meta.url), 'utf8')));
} catch {
  // The placeholder PAT is fine for a deadlock probe.
}

const presets = JSON.parse(readFileSync(new URL('../data/preset-decks.resolved.json', import.meta.url), 'utf8'));
const decks = Array.isArray(presets) ? presets : presets.decks;
if (!decks || decks.length < 2) {
  console.error('need at least 2 resolved preset decks');
  process.exit(1);
}

let state = createGame(
  { seed: SEED, players: [{ name: 'A', deck: decks[0] }, { name: 'B', deck: decks[1] }] },
  db,
);

/** Answer whatever is being asked, preferring the option that keeps play moving. */
function answerFor(prompt) {
  switch (prompt.type) {
    case 'declareCombat':
      // Alternate so both branches of the Declare Step get exercised.
      return { declare: PEACEFUL ? false : state.turnNumber % 2 === 0 };
    case 'discard': {
      const opts = Array.isArray(prompt.options) ? prompt.options : [];
      return { uid: opts.length ? opts[0].uid : null };
    }
    case 'rejuvenate':
      return { take: true };
    case 'defend':
      return { takeDamage: true };
    case 'endurance':
      return { use: false };
    case 'capture':
      return { uid: null };
    case 'redirect':
      return { toUid: null };
    case 'controlOfCombat': {
      const opts = Array.isArray(prompt.options) ? prompt.options : [];
      return { uid: opts.length ? opts[0].uid : null };
    }
    default:
      return null;
  }
}

const counts = { prompts: {}, errors: {}, steps: 0, actions: 0 };
let stalls = 0;
let lastSignature = '';
/** Turns on which the active player has already tried their Non-Combat Step. */
const playedThisTurn = new Set();

for (let i = 0; i < TURNS * 60 && state.phase === 'playing' && state.turnNumber <= TURNS; i++) {
  const signature = `${state.turnNumber}|${state.step}|${state.pendingPrompt?.id ?? '-'}|${state.combat?.phasePlayerIdx ?? '-'}|${state.combat?.currentAttack ? 'atk' : '-'}`;
  if (signature === lastSignature) {
    if (++stalls > 40) {
      console.error(`\nWEDGED at ${signature}`);
      console.error('prompt: ' + JSON.stringify(state.pendingPrompt));
      console.error('attack: ' + JSON.stringify(state.combat?.currentAttack));
      console.error('answer sent: ' + JSON.stringify(state.pendingPrompt ? answerFor(state.pendingPrompt) : null));
      console.error('last error: ' + JSON.stringify(Object.keys(counts.errors).slice(-4)));
      console.error('last log lines:\n  ' + state.log.slice(-12).join('\n  '));
      process.exit(1);
    }
  } else {
    stalls = 0;
    lastSignature = signature;
  }

  const prompt = state.pendingPrompt;
  let result;
  if (prompt) {
    counts.prompts[prompt.type] = (counts.prompts[prompt.type] ?? 0) + 1;
    result = reduce(state, { type: 'answerPrompt', promptId: prompt.id, choice: answerFor(prompt) }, db, prompt.playerIdx);
  } else if (state.combat && state.combat.phasePlayerIdx != null) {
    // In Combat with no question pending. An attack needs a source, so: attack
    // with a card that can, else spend a card on a Final Physical Attack, else
    // pass. That is the CRD's list of what an Attack Phase can be spent on.
    const who = state.combat.phasePlayerIdx;
    const hand = state.players[who].zones.hand;
    const weapon = hand.find((c) => {
      const t = db.type(c.cardId);
      return t === 'Unknown' || /combat/i.test(t);
    });
    const power = reduce(state, { type: 'usePersonalityPower' }, db, who);
    if (!power.error) {
      counts.powers = (counts.powers ?? 0) + 1;
      result = power;
    } else if (weapon) {
      result = reduce(state, { type: 'declareAttack', attackType: 'physical', cardUid: weapon.uid }, db, who);
    } else if (hand.length > 0 && !state.combat.finalUsed.includes(who)) {
      result = reduce(state, { type: 'finalPhysicalAttack', discardUid: hand[0].uid }, db, who);
    } else {
      result = { state, error: 'nothing to attack with' };
    }
    if (result.error) result = reduce(state, { type: 'pass' }, db, who);
  } else if (state.step === 'nonCombat' && !playedThisTurn.has(state.turnNumber)) {
    // Put something on the table before moving on. Without this the driver
    // never played a single Non-Combat card, so Drills, Locations and every
    // continuous modifier went completely unexercised by the smoke test.
    const who = state.activePlayerIdx;
    const playable = state.players[who].zones.hand.filter((c) => {
      const t = db.type(c.cardId);
      return t === 'Non-Combat' || t === 'Drill' || t === 'Location' || t === 'Battleground' || t === 'Dragon Ball';
    });
    let played = false;
    for (const card of playable) {
      const r = reduce(state, { type: 'playCard', playerIdx: who, cardUid: card.uid }, db, who);
      if (!r.error) {
        counts.played = (counts.played ?? 0) + 1;
        state = r.state;
        played = true;
        break;
      }
      counts.errors[r.error] = (counts.errors[r.error] ?? 0) + 1;
    }
    playedThisTurn.add(state.turnNumber);
    if (played) continue;
    counts.steps += 1;
    result = reduce(state, { type: 'advanceStep' }, db, state.activePlayerIdx);
  } else {
    counts.steps += 1;
    result = reduce(state, { type: 'advanceStep' }, db, state.activePlayerIdx);
  }

  counts.actions += 1;
  if (result.error) counts.errors[result.error] = (counts.errors[result.error] ?? 0) + 1;
  state = result.state;
}

const hands = state.players.map((p) => `${p.name} hand=${p.zones.hand.length} deck=${p.zones.lifeDeck.length} discard=${p.zones.discard.length}`);
console.log(`turns reached: ${state.turnNumber}   phase: ${state.phase}${state.winnerIdx != null ? `   winner: ${state.players[state.winnerIdx].name} (${state.victoryType})` : ''}`);
console.log(`actions: ${counts.actions}  step advances: ${counts.steps}`);
console.log('prompts answered:', counts.prompts, ' cards played:', counts.played ?? 0, ' powers used:', counts.powers ?? 0);
console.log(hands.join('\n'));
const errs = Object.entries(counts.errors).sort((a, b) => b[1] - a[1]);
if (errs.length) {
  console.log('\nrefusals (expected ones are fine — this is a dumb driver):');
  for (const [msg, n] of errs.slice(0, 12)) console.log(`  ${String(n).padStart(4)}x ${msg}`);
}

const maxHand = Math.max(...state.players.map((p) => p.zones.hand.length));
if (maxHand > 8) {
  console.error(`\nHAND LIMIT NOT BITING: largest hand is ${maxHand}`);
  process.exit(1);
}
console.log(`\nok — no deadlock, largest hand ${maxHand}`);
