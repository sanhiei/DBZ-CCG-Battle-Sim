/** Parser tests. These run on synthetic saves so they don't need the mod installed. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheKey } from './cache.js';
import { extractCards, pickSaga, resolveAtlas, sagaFromContainer } from './parse.js';
import type { TtsSave } from './types.js';

const deck = (faceUrl: string) => ({ '1': { FaceURL: faceUrl, NumWidth: 10, NumHeight: 7 } });
const card = (nickname: string, cardId: number, extra: Record<string, unknown> = {}) => ({
  Name: 'Card',
  Nickname: nickname,
  CardID: cardId,
  ...extra,
});

test('saga inference', async (t) => {
  await t.test('maps the mod\'s container names', () => {
    assert.equal(sagaFromContainer('SaiyanSagaPCB'), 'Saiyan');
    assert.equal(sagaFromContainer('FreSagaPCB'), 'Frieza');
    assert.equal(sagaFromContainer('WoGSagaPCB'), 'World Games');
    assert.equal(sagaFromContainer('KidSagaPCB'), 'Kid Buu');
  });

  await t.test('tests Cell Games before Cell', () => {
    assert.equal(sagaFromContainer('CellGSagaPCB'), 'Cell Games');
    assert.equal(sagaFromContainer('CellSagaPCB'), 'Cell');
  });

  await t.test('is Unknown for promo/subset bags', () => {
    assert.equal(sagaFromContainer('RetroCardSet'), 'Unknown');
    assert.equal(sagaFromContainer('TuffEnuffCardSet'), 'Unknown');
  });

  await t.test('prefers a main-set container over a subset bag', () => {
    // Android 13 sits in both an "Android 13 Subset" bag and the Babidi box.
    assert.equal(pickSaga(['Android 13 Subset > Open', 'BabSagaPCB']), 'Babidi');
    assert.equal(pickSaga(['RetroCardSet', 'SaiyanSagaPCB']), 'Saiyan');
    assert.equal(pickSaga(['RetroCardSet']), 'Unknown');
  });
});

test('atlas resolution', async (t) => {
  await t.test('splits CardID into atlas key and cell', () => {
    const ref = resolveAtlas(525, { '5': { FaceURL: 'u', NumWidth: 10, NumHeight: 7 } })!;
    assert.equal(ref.cellIndex, 25);
    assert.equal(ref.col, 5);
    assert.equal(ref.row, 2);
  });

  await t.test('handles a 1x1 single-card sheet', () => {
    const ref = resolveAtlas(100, { '1': { FaceURL: 'u', NumWidth: 1, NumHeight: 1 } })!;
    assert.deepEqual([ref.col, ref.row], [0, 0]);
  });

  await t.test('returns undefined without a face', () => {
    assert.equal(resolveAtlas(100, {}), undefined);
    assert.equal(resolveAtlas(undefined, { '1': { FaceURL: 'u' } }), undefined);
  });
});

test('extraction', async (t) => {
  await t.test('identifies cards by atlas cell, not name', () => {
    // Every Goku level card is nicknamed just "Goku"; they must stay distinct.
    const save: TtsSave = {
      SaveName: 'test',
      ObjectStates: [
        {
          Name: 'Deck',
          Nickname: 'SaiyanSagaPCB',
          CustomDeck: deck('atlas-a'),
          ContainedObjects: [card('Goku', 100), card('Goku', 101), card('Goku', 102)],
        },
      ],
    };
    const result = extractCards(save);
    assert.equal(result.stats.uniqueCards, 3, 'three different Goku levels');
    assert.equal(new Set(result.cards.map((c) => c.id)).size, 3, 'ids are distinct');
  });

  await t.test('collapses the same face found in several bags', () => {
    const save: TtsSave = {
      ObjectStates: [
        { Name: 'Deck', Nickname: 'BabSagaPCB', CustomDeck: deck('atlas-a'), ContainedObjects: [card('Android 13', 100)] },
        { Name: 'Bag', Nickname: 'Android 13 Subset', CustomDeck: deck('atlas-a'), ContainedObjects: [card('Android 13', 100)] },
      ],
    };
    const result = extractCards(save);
    assert.equal(result.stats.uniqueCards, 1);
    const only = result.cards[0]!;
    assert.equal(only.copies, 2);
    assert.equal(only.containers.length, 2);
    assert.equal(only.saga, 'Babidi', 'main-set container wins');
  });

  await t.test('keeps errata and inherits the atlas from a parent deck', () => {
    const save: TtsSave = {
      ObjectStates: [
        {
          Name: 'Deck',
          Nickname: 'SaiyanSagaPCB',
          CustomDeck: deck('atlas-a'),
          ContainedObjects: [card('Ingrain in the Membrane', 105, { Description: 'ruling text\r' })],
        },
      ],
    };
    const result = extractCards(save);
    assert.equal(result.cards[0]!.errata, 'ruling text', 'CR stripped');
    assert.equal(result.cards[0]!.atlas.faceUrl, 'atlas-a', 'inherited from the deck');
    assert.equal(result.stats.withErrata, 1);
  });

  await t.test('ids are deterministic across runs', () => {
    const save: TtsSave = {
      ObjectStates: [{ Name: 'Deck', Nickname: 'SaiyanSagaPCB', CustomDeck: deck('atlas-a'), ContainedObjects: [card('X', 103)] }],
    };
    assert.equal(extractCards(save).cards[0]!.id, extractCards(save).cards[0]!.id);
  });

  await t.test('skips nameless objects without crashing', () => {
    const save: TtsSave = {
      ObjectStates: [{ Name: 'Deck', CustomDeck: deck('a'), ContainedObjects: [card('', 100), { Name: 'Card' }] }],
    };
    assert.equal(extractCards(save).stats.uniqueCards, 0);
  });
});

test('image cache key matches TTS naming', () => {
  assert.equal(cacheKey('http://u.cubeupload.com/Strinder/Pacsaiyan.jpg'), 'httpucubeuploadcomStrinderPacsaiyanjpg');
});
