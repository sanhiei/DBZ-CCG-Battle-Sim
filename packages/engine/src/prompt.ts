/**
 * One source of prompt ids for the whole engine.
 *
 * This started as a counter private to combat.ts. The moment a second module
 * needed to raise a prompt, a second counter would have handed out `p1` again
 * while `p1` was still open somewhere else — and `answerPrompt` compares
 * promptIds to decide whether an answer is stale, so colliding ids would let
 * exactly the double-click it guards against back through.
 */
import type { Prompt } from '@dbz/shared';

let promptSeq = 0;

export function newPrompt(playerIdx: number, type: string, message: string, extra: Partial<Prompt> = {}): Prompt {
  promptSeq += 1;
  return { id: `p${promptSeq}`, playerIdx, type, message, ...extra };
}
