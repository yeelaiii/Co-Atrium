import { assert, assertEquals, assertFalse } from '@std/assert';

import {
  canTransition,
  contractSum,
  currentAmount,
  statusAfterEvent,
  transitionPairs,
  VO_CONTRACT_STATUSES,
  voCompletionExtensions,
  type VoAmounts,
} from '../_shared/contracts/variations.ts';

Deno.test('VO transitions: the main line, forward skips and branches are allowed', () => {
  assert(canTransition('identified', 'instructed'));
  assert(canTransition('instructed', 'quotation_submitted'));
  assert(canTransition('quotation_submitted', 'valuation_issued'));
  assert(canTransition('valuation_issued', 'agreed'));
  assert(canTransition('instructed', 'valuation_issued'), 'no quotation required');
  assert(canTransition('valuation_issued', 'disputed'));
  assert(canTransition('disputed', 'agreed'));
  assert(canTransition('disputed', 'valuation_issued'), 're-valued after an objection');
  assert(canTransition('unconfirmed', 'instructed'));
  assert(canTransition('quotation_submitted', 'withdrawn'));
});

Deno.test('VO transitions: backwards, out of final states and skipping confirmation are rejected', () => {
  assertFalse(canTransition('agreed', 'disputed'));
  assertFalse(canTransition('agreed', 'instructed'));
  assertFalse(canTransition('valuation_issued', 'quotation_submitted'));
  assertFalse(canTransition('withdrawn', 'identified'));
  assertFalse(canTransition('rejected', 'agreed'));
  assertFalse(canTransition('unconfirmed', 'agreed'), 'an oral instruction must be confirmed first');
  assertFalse(canTransition('unconfirmed', 'valuation_issued'));
  assertFalse(canTransition('identified', 'unconfirmed'));
  for (const s of VO_CONTRACT_STATUSES) assertFalse(canTransition(s, s), `${s} -> ${s}`);
});

Deno.test('VO transitions: the pair list has every allowed move once (mirrored in SQL)', () => {
  const pairs = transitionPairs();
  assertEquals(new Set(pairs.map((p) => p.join('>'))).size, pairs.length);
  assertEquals(pairs.length, 29);
});

Deno.test('events move a VO along only when the move is allowed', () => {
  assertEquals(statusAfterEvent('unconfirmed', 'oral_instruction_confirmed'), 'instructed');
  assertEquals(statusAfterEvent('identified', 'instruction_issued'), 'instructed');
  assertEquals(statusAfterEvent('instructed', 'variation_quotation_submitted'), 'quotation_submitted');
  assertEquals(statusAfterEvent('quotation_submitted', 'variation_valuation_issued'), 'valuation_issued');
  assertEquals(statusAfterEvent('valuation_issued', 'variation_objection_served'), 'disputed');
  assertEquals(statusAfterEvent('agreed', 'variation_objection_served'), 'agreed', 'final states stay');
  assertEquals(statusAfterEvent('valuation_issued', 'variation_quotation_submitted'), 'valuation_issued', 'never backwards');
  assertEquals(statusAfterEvent('instructed', 'rfi_submitted'), 'instructed');
});

const vo = (status: VoAmounts['status'], amounts: Partial<VoAmounts> = {}): VoAmounts => ({
  status,
  claimed: null,
  assessed: null,
  agreed: null,
  isOmission: false,
  ...amounts,
});

Deno.test('revised contract sum: additions minus omissions, pending and disputed kept apart', () => {
  const sum = contractSum(1_000_000, [
    vo('agreed', { claimed: 60_000, assessed: 55_000, agreed: 50_000.1 }),
    vo('agreed', { agreed: 20_000.2, isOmission: true }),
    vo('agreed', { agreed: 0 }), // time-only variation
    vo('valuation_issued', { claimed: 12_000, assessed: 10_000 }), // assessed beats claimed
    vo('quotation_submitted', { claimed: 8_000 }),
    vo('instructed', { claimed: 3_000, isOmission: true }),
    vo('instructed'), // unpriced
    vo('disputed', { claimed: 40_000, assessed: 30_000 }),
    vo('withdrawn', { claimed: 99_999 }),
    vo('rejected', { claimed: 99_999 }),
  ]);
  assertEquals(sum.agreed, 29_999.9);
  assertEquals(sum.revised, 1_029_999.9);
  assertEquals(sum.pending, 15_000);
  assertEquals(sum.revisedInclPending, 1_044_999.9);
  assertEquals(sum.disputed, 30_000);
  assertEquals(sum.unpriced, 1);
  assertEquals(sum.count, 10);
});

Deno.test('contract sum without a confirmed original: totals still add up, revised is null', () => {
  const sum = contractSum(null, [vo('agreed', { agreed: 100 })]);
  assertEquals(sum.agreed, 100);
  assertEquals(sum.revised, null);
  assertEquals(sum.revisedInclPending, null);
});

Deno.test('current amount: agreed if agreed, else assessed, else claimed; omissions negative', () => {
  assertEquals(currentAmount(vo('agreed', { claimed: 5, assessed: 4, agreed: 3 })), 3);
  assertEquals(currentAmount(vo('valuation_issued', { claimed: 5, assessed: 4 })), 4);
  assertEquals(currentAmount(vo('quotation_submitted', { claimed: 5, isOmission: true })), -5);
  assertEquals(currentAmount(vo('identified')), null);
});

Deno.test('agreed VO time extends completion unless an EOT decision carries it', () => {
  const ext = voCompletionExtensions([
    { number: 3, status: 'agreed', timeImpactDaysAgreed: 10, eotEventId: null },
    { number: 4, status: 'agreed', timeImpactDaysAgreed: 7, eotEventId: 'e-eot' },
    { number: 5, status: 'valuation_issued', timeImpactDaysAgreed: 5, eotEventId: null },
    { number: 6, status: 'agreed', timeImpactDaysAgreed: 0, eotEventId: null },
  ]);
  assertEquals(ext, [{ days: 10, label: 'VO-3' }]);
});
