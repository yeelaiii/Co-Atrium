// Contractual layer of variation orders: lifecycle, transitions and contract sum maths.
// Pure: shared by the app (@shared/contracts/variations.ts), the Edge Functions and the tests.
// The transition list must match private.vo_status_transitions (migration 0023); a pgTAP test
// checks the SQL copy row for row.

import type { EventType } from './eventTypes.ts';

export const VO_CONTRACT_STATUSES = [
  'unconfirmed',
  'identified',
  'instructed',
  'quotation_submitted',
  'valuation_issued',
  'agreed',
  'disputed',
  'rejected',
  'withdrawn',
] as const;
export type VoContractStatus = (typeof VO_CONTRACT_STATUSES)[number];

export const VO_STATUS_LABEL: Record<VoContractStatus, string> = {
  unconfirmed: 'Unconfirmed (oral)',
  identified: 'Identified',
  instructed: 'Instructed',
  quotation_submitted: 'Quotation submitted',
  valuation_issued: 'Valuation issued',
  agreed: 'Agreed',
  disputed: 'Disputed',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

export const VO_SOURCES = ['written_instruction', 'oral_instruction_confirmed', 'contractor_proposal', 'client_request'] as const;
export type VoSource = (typeof VO_SOURCES)[number];

export const VO_SOURCE_LABEL: Record<VoSource, string> = {
  written_instruction: 'Written instruction',
  oral_instruction_confirmed: 'Oral instruction, confirmed',
  contractor_proposal: 'Contractor proposal',
  client_request: 'Client request',
};

/** The main line. A VO may skip forward (e.g. no quotation required: instructed -> valuation_issued). */
const MAIN: VoContractStatus[] = ['identified', 'instructed', 'quotation_submitted', 'valuation_issued', 'agreed'];
const BRANCHES: VoContractStatus[] = ['disputed', 'rejected', 'withdrawn'];

function buildTransitions(): Record<VoContractStatus, VoContractStatus[]> {
  const t = {} as Record<VoContractStatus, VoContractStatus[]>;
  MAIN.forEach((s, i) => {
    t[s] = s === 'agreed' ? [] : [...MAIN.slice(i + 1), ...BRANCHES];
  });
  // An oral (site) instruction must be confirmed or turned into a written one first.
  t.unconfirmed = ['identified', 'instructed', 'withdrawn'];
  // After an objection: re-valued, settled, or dropped.
  t.disputed = ['valuation_issued', 'agreed', 'rejected', 'withdrawn'];
  t.rejected = [];
  t.withdrawn = [];
  return t;
}

/** Allowed next states. agreed, rejected and withdrawn are final. */
export const VO_TRANSITIONS: Readonly<Record<VoContractStatus, readonly VoContractStatus[]>> = buildTransitions();

export function canTransition(from: VoContractStatus, to: VoContractStatus): boolean {
  return VO_TRANSITIONS[from].includes(to);
}

/** Every allowed (from, to) pair, for the SQL mirror test. */
export function transitionPairs(): [VoContractStatus, VoContractStatus][] {
  return VO_CONTRACT_STATUSES.flatMap((from) => VO_TRANSITIONS[from].map((to) => [from, to] as [VoContractStatus, VoContractStatus]));
}

/**
 * Logging one of these events against a VO moves it to that status, when the move is allowed
 * (otherwise the status stays). Mirrors private.apply_vo_event (migration 0023).
 */
export const VO_EVENT_STATUS: Partial<Record<EventType, VoContractStatus>> = {
  instruction_issued: 'instructed',
  oral_instruction_confirmed: 'instructed',
  variation_quotation_submitted: 'quotation_submitted',
  variation_valuation_issued: 'valuation_issued',
  variation_objection_served: 'disputed',
};

export function statusAfterEvent(current: VoContractStatus, eventType: string): VoContractStatus {
  const target = (VO_EVENT_STATUS as Record<string, VoContractStatus | undefined>)[eventType];
  return target && canTransition(current, target) ? target : current;
}

/** Rule groups suggested (never opened) when a VO records a claimed time impact. */
export const VO_TIME_IMPACT_CHAINS = ['eot_notice'];

/** Still in play: counts towards "pending". */
export const VO_PENDING_STATUSES: VoContractStatus[] = ['unconfirmed', 'identified', 'instructed', 'quotation_submitted', 'valuation_issued'];
/** No longer counts towards anything. */
export const VO_CLOSED_STATUSES: VoContractStatus[] = ['rejected', 'withdrawn'];

export interface VoAmounts {
  status: VoContractStatus;
  claimed: number | null;
  assessed: number | null;
  agreed: number | null;
  isOmission: boolean;
}

/** Cents, so totals are exact. */
const cents = (n: number) => Math.round(n * 100);
const sign = (vo: VoAmounts) => (vo.isOmission ? -1 : 1);

/** The amount a VO currently stands at: agreed if agreed, else assessed, else claimed. Signed (omissions negative). */
export function currentAmount(vo: VoAmounts): number | null {
  const v = vo.status === 'agreed' ? vo.agreed : vo.assessed ?? vo.claimed;
  return v === null ? null : (sign(vo) * cents(v)) / 100;
}

export interface ContractSum {
  original: number | null;
  /** Σ agreed amounts (omissions negative). */
  agreed: number;
  /** Σ assessed, else claimed, of VOs still in progress. */
  pending: number;
  /** Σ assessed, else claimed, of disputed VOs. */
  disputed: number;
  /** original + agreed. Null without a confirmed contract sum. */
  revised: number | null;
  /** revised + pending (not disputed). Labelled as an estimate in the app. */
  revisedInclPending: number | null;
  /** In-progress or disputed VOs with no amount yet: the estimate leaves them out. */
  unpriced: number;
  count: number;
}

/**
 * Revised contract sum = original + Σ agreed VO amounts (additions minus omissions).
 * Mirrors project_contract_sum() in SQL (migration 0023).
 */
export function contractSum(original: number | null, vos: VoAmounts[]): ContractSum {
  let agreed = 0;
  let pending = 0;
  let disputed = 0;
  let unpriced = 0;
  for (const vo of vos) {
    if (vo.status === 'agreed') {
      agreed += sign(vo) * cents(vo.agreed ?? 0);
      continue;
    }
    if (VO_CLOSED_STATUSES.includes(vo.status)) continue;
    const v = vo.assessed ?? vo.claimed;
    if (v === null) {
      unpriced++;
      continue;
    }
    if (vo.status === 'disputed') disputed += sign(vo) * cents(v);
    else pending += sign(vo) * cents(v);
  }
  const revised = original === null ? null : cents(original) + agreed;
  return {
    original,
    agreed: agreed / 100,
    pending: pending / 100,
    disputed: disputed / 100,
    revised: revised === null ? null : revised / 100,
    revisedInclPending: revised === null ? null : (revised + pending) / 100,
    unpriced,
    count: vos.length,
  };
}

/** Extensions to the completion date from agreed VOs. A VO tied to an EOT decision counts through that event instead. */
export function voCompletionExtensions(
  vos: { number: number; status: VoContractStatus; timeImpactDaysAgreed: number | null; eotEventId: string | null }[],
): { days: number; label: string }[] {
  return vos
    .filter((v) => v.status === 'agreed' && (v.timeImpactDaysAgreed ?? 0) > 0 && !v.eotEventId)
    .map((v) => ({ days: v.timeImpactDaysAgreed!, label: `VO-${v.number}` }));
}
