/**
 * Engine smoke test. Built by tsc, run as: node dist/engine.test.js
 * Validates setup, step sequencing, power-up, anger->advancement, and a basic
 * energy attack, using real enriched Saiyan card data.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { DeckList } from '@dbz/shared';
import { CardDb, type EngineCard } from './loader.js';
import { createGame } from './setup.js';
import { reduce } from './reducer.js';
import { findPersonality } from './turn.js';
import { computeBaseDamage, setPatTable } from './pat.js';
import { controllerOf } from './combat.js';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const dataFile = join(here, '..', '..', '..', 'data', 'cards.saiyan.enriched.json');
const cards: EngineCard[] = JSON.parse(readFileSync(dataFile, 'utf8'));
const db = new CardDb(cards);
setPatTable(JSON.parse(readFileSync(join(here, '..', '..', '..', 'data', 'pat.json'), 'utf8')));

function id(name: string): string {
  const c = cards.find((x) => x.name === name);
  if (!c) throw new Error(`missing card: ${name}`);
  return c.id;
}

// Build a 50-card life deck from a few commons.
const fillers = cards.filter((c) => !c.rules?.personality && c.number != null).slice(0, 5).map((c) => c.id);
const life = fillers.map((cardId, i) => ({ cardId, qty: i === 0 ? 46 : 1 })); // ~50

const gokuDeck: DeckList = {
  name: 'Goku', mpLevels: [id('Goku LV1'), id('Goku LV2'), id('Goku LV3')], life,
};
const vegetaDeck: DeckList = {
  name: 'Vegeta', mpLevels: [id('Vegeta LV1'), id('Vegeta LV2'), id('Vegeta LV3')], life,
};

console.log('createGame:');
let state = createGame({ seed: 42, players: [{ name: 'Goku', deck: gokuDeck }, { name: 'Vegeta', deck: vegetaDeck }] }, db);
check('two players', state.players.length === 2);
check('MP name Goku', state.players[0]!.mp.personalityName === 'Goku', `got ${state.players[0]!.mp.personalityName}`);
check('scouter at 5 above 0 (stageIndex 5)', state.players[0]!.mp.stageIndex === 5, `got ${state.players[0]!.mp.stageIndex}`);
check('life deck 50', state.players[0]!.zones.lifeDeck.length === 50, `got ${state.players[0]!.zones.lifeDeck.length}`);
check('deterministic first player', state.activePlayerIdx === createGame({ seed: 42, players: [{ name: 'Goku', deck: gokuDeck }, { name: 'Vegeta', deck: vegetaDeck }] }, db).activePlayerIdx);

console.log('turn sequencing:');
const startStage = state.players[state.activePlayerIdx]!.mp.stageIndex;
let r = reduce(state, { type: 'advanceStep' }, db); state = r.state; // draw -> nonCombat
check('advanced to nonCombat', state.step === 'nonCombat', `got ${state.step}`);
r = reduce(state, { type: 'advanceStep' }, db); state = r.state; // -> powerUp (auto power-up)
check('powered up +PUR', state.players[state.activePlayerIdx]!.mp.stageIndex > startStage, `from ${startStage} to ${state.players[state.activePlayerIdx]!.mp.stageIndex}`);

console.log('anger -> advancement:');
const mpUid = state.players[state.activePlayerIdx]!.mp.uid;
r = reduce(state, { type: 'setAnger', personalityUid: mpUid, anger: 5 }, db); state = r.state;
const mp = findPersonality(state, mpUid)!;
check('advanced to level 2', mp.currentLevel === 2, `got ${mp.currentLevel}`);
check('anger reset to 0', mp.anger === 0, `got ${mp.anger}`);

console.log('energy attack (no PAT needed):');
// Fast-forward to combat step of active player.
let guard = 0;
while (state.step !== 'combat' && guard++ < 10) { r = reduce(state, { type: 'advanceStep' }, db); state = r.state; }
const defenderIdx = (state.activePlayerIdx + 1) % 2;
const beforeLife = state.players[defenderIdx]!.zones.lifeDeck.length;
r = reduce(state, { type: 'declareAttack', attackType: 'energy' }, db); state = r.state;
r = reduce(state, { type: 'defend', takeDamage: true }, db); state = r.state;
const afterLife = state.players[defenderIdx]!.zones.lifeDeck.length;
check('energy attack removed 4 life cards', beforeLife - afterLife === 4, `${beforeLife} -> ${afterLife}`);

console.log('full combat (alternating Attack Phases + PAT):');
let g = createGame({ seed: 7, players: [{ name: 'Goku', deck: gokuDeck }, { name: 'Vegeta', deck: vegetaDeck }] }, db);
const atkIdx = g.activePlayerIdx;
const defIdx = (atkIdx + 1) % 2;
let gg;
let guard2 = 0;
while (g.step !== 'combat' && guard2++ < 12) { gg = reduce(g, { type: 'advanceStep' }, db); g = gg.state; }
check('reached combat step', g.step === 'combat');
check('prepare: defender drew 3', g.players[defIdx]!.zones.hand.length === 3, `got ${g.players[defIdx]!.zones.hand.length}`);
check('attacker gets first Attack Phase', g.combat!.phasePlayerIdx === atkIdx);

const attRating = controllerOf(g.players[atkIdx]!).currentRating;
const defCtl = controllerOf(g.players[defIdx]!);
const expected = computeBaseDamage(attRating, defCtl.currentRating);
const defStageBefore = defCtl.stageIndex;

gg = reduce(g, { type: 'declareAttack', attackType: 'physical' }, db, atkIdx); g = gg.state;
check('physical attack prompts defender', g.pendingPrompt?.type === 'defend' && g.pendingPrompt.playerIdx === defIdx, gg.error ?? '');

gg = reduce(g, { type: 'defend', takeDamage: true }, db, defIdx); g = gg.state;
const defStageAfter = findPersonality(g, defCtl.uid)!.stageIndex;
check('defender lost PAT base damage in power stages', defStageBefore - defStageAfter === expected, `expected ${expected}, lost ${defStageBefore - defStageAfter}`);
check('phase passed to defender', g.combat!.phasePlayerIdx === defIdx);
check('prompt cleared', !g.pendingPrompt);

gg = reduce(g, { type: 'pass' }, db, defIdx); g = gg.state;
check('defender pass -> attacker phase', g.combat!.phasePlayerIdx === atkIdx && g.combat!.consecutivePasses === 1);
gg = reduce(g, { type: 'pass' }, db, atkIdx); g = gg.state;
check('both pass -> Combat Step ends (discard)', g.step === 'discard' && !g.combat, `step ${g.step}`);

console.log('combat guards:');
gg = reduce(g, { type: 'declareAttack', attackType: 'physical' }, db, atkIdx);
check('cannot attack outside combat', gg.error !== undefined, 'expected error');

console.log('card ability execution (attack from a card):');
let h = createGame({ seed: 3, players: [{ name: 'Goku', deck: gokuDeck }, { name: 'Vegeta', deck: vegetaDeck }] }, db);
const aIdx = h.activePlayerIdx;
const dIdx = (aIdx + 1) % 2;
// Put a known attack card ("One Knuckle Punch": physical +1 stage, raise user anger 1) in attacker's hand.
h.players[aIdx]!.zones.hand.push({ uid: 'test-atk', cardId: id('One Knuckle Punch'), faceDown: false });
let guard3 = 0;
while (h.step !== 'combat' && guard3++ < 12) { const rr2 = reduce(h, { type: 'advanceStep' }, db); h = rr2.state; }
const attCtl2 = controllerOf(h.players[aIdx]!);
const defCtl2 = controllerOf(h.players[dIdx]!);
const angerBefore = h.players[aIdx]!.mp.anger;
const expected2 = computeBaseDamage(attCtl2.currentRating, defCtl2.currentRating) + 1; // +1 stage modifier
const defStage2 = defCtl2.stageIndex;

let rr3 = reduce(h, { type: 'declareAttack', attackType: 'physical', cardUid: 'test-atk' }, db, aIdx); h = rr3.state;
check('ability raised user anger +1 on attack', h.players[aIdx]!.mp.anger === angerBefore + 1, `${angerBefore} -> ${h.players[aIdx]!.mp.anger}`);
check('attack prompts defender', h.pendingPrompt?.type === 'defend', rr3.error ?? '');
rr3 = reduce(h, { type: 'defend', takeDamage: true }, db, dIdx); h = rr3.state;
const defStage2After = findPersonality(h, defCtl2.uid)!.stageIndex;
check('ability applied base+modifier power stages', defStage2 - defStage2After === expected2, `expected ${expected2}, lost ${defStage2 - defStage2After}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
