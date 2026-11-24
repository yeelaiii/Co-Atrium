// Project event types. Must match the project_event_type_valid check (migration 0020).

export const EVENT_TYPES = [
  'rfi_submitted',
  'rfi_responded',
  'rfa_submitted',
  'rfa_responded',
  'shop_drawing_submitted',
  'shop_drawing_reviewed',
  'payment_claim_served',
  'payment_response_served',
  'payment_certificate_issued',
  'instruction_issued',
  'oral_instruction_received',
  'oral_instruction_confirmed',
  'variation_quotation_submitted',
  'variation_valuation_issued',
  'variation_objection_served',
  'delay_event_occurred',
  'eot_notice_served',
  'eot_decision_issued',
  'completion_certified',
  'defect_notified',
  'defect_rectified',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Pseudo-trigger for rules anchored on the (extended) completion date instead of an event. */
export const COMPLETION_TRIGGER = 'completion_date';
/** Pseudo-trigger for rules only reached through another rule's chains_to. */
export const CHAINED_TRIGGER = 'chained';
export const TRIGGER_TYPES = [...EVENT_TYPES, COMPLETION_TRIGGER, CHAINED_TRIGGER] as const;

export interface EventTypeInfo {
  /** Picker label. */
  label: string;
  /** Words used in explanations: "21 calendar days after <trigger> on 3 Mar 2026". */
  trigger: string;
  /** Reference prefix suggested in the form. */
  refPrefix: string | null;
  /** Request types this event typically answers (used to suggest `related_event_id`). */
  responds_to: EventType[];
  /** True for documents, whose deadlines run from service. */
  served: boolean;
}

export const EVENT_TYPE_INFO: Record<EventType, EventTypeInfo> = {
  rfi_submitted: { label: 'RFI submitted', trigger: 'RFI submitted', refPrefix: 'RFI', responds_to: [], served: true },
  rfi_responded: { label: 'RFI responded', trigger: 'RFI response', refPrefix: 'RFI', responds_to: ['rfi_submitted'], served: true },
  rfa_submitted: { label: 'RFA submitted', trigger: 'RFA submitted', refPrefix: 'RFA', responds_to: [], served: true },
  rfa_responded: { label: 'RFA responded', trigger: 'RFA response', refPrefix: 'RFA', responds_to: ['rfa_submitted'], served: true },
  shop_drawing_submitted: { label: 'Shop drawing submitted', trigger: 'shop drawing submitted', refPrefix: 'SD', responds_to: [], served: true },
  shop_drawing_reviewed: { label: 'Shop drawing reviewed', trigger: 'shop drawing review', refPrefix: 'SD', responds_to: ['shop_drawing_submitted'], served: true },
  payment_claim_served: { label: 'Payment claim served', trigger: 'payment claim served', refPrefix: 'PC', responds_to: [], served: true },
  payment_response_served: { label: 'Payment response served', trigger: 'payment response served', refPrefix: 'PR', responds_to: ['payment_claim_served'], served: true },
  payment_certificate_issued: { label: 'Payment certificate issued', trigger: 'payment certificate issued', refPrefix: 'IPC', responds_to: ['payment_claim_served'], served: true },
  instruction_issued: { label: 'Instruction issued (AI / SOI)', trigger: 'instruction issued', refPrefix: 'AI', responds_to: ['oral_instruction_received'], served: true },
  oral_instruction_received: { label: 'Oral instruction received', trigger: 'oral instruction received', refPrefix: 'OI', responds_to: [], served: false },
  oral_instruction_confirmed: { label: 'Oral instruction confirmed in writing', trigger: 'written confirmation of oral instruction', refPrefix: 'CVI', responds_to: ['oral_instruction_received'], served: true },
  variation_quotation_submitted: { label: 'Variation quotation submitted', trigger: 'variation quotation submitted', refPrefix: 'VQ', responds_to: ['instruction_issued'], served: true },
  variation_valuation_issued: { label: 'Variation valuation issued', trigger: 'variation valuation issued', refPrefix: 'VV', responds_to: ['variation_quotation_submitted'], served: true },
  variation_objection_served: { label: 'Objection to variation served', trigger: 'objection served', refPrefix: null, responds_to: ['variation_valuation_issued', 'instruction_issued'], served: true },
  delay_event_occurred: { label: 'Delay event occurred', trigger: 'delay event', refPrefix: 'DE', responds_to: [], served: false },
  eot_notice_served: { label: 'EOT notice served', trigger: 'EOT notice served', refPrefix: 'EOT', responds_to: ['delay_event_occurred'], served: true },
  eot_decision_issued: { label: 'EOT decision issued', trigger: 'EOT decision issued', refPrefix: 'EOT', responds_to: ['eot_notice_served'], served: true },
  completion_certified: { label: 'Completion certified', trigger: 'completion certified', refPrefix: 'CC', responds_to: [], served: true },
  defect_notified: { label: 'Defect notified', trigger: 'defect notified', refPrefix: 'DN', responds_to: [], served: true },
  defect_rectified: { label: 'Defect rectified', trigger: 'defect rectified', refPrefix: 'DN', responds_to: ['defect_notified'], served: false },
};

export function triggerLabel(triggerType: string): string {
  if (triggerType === COMPLETION_TRIGGER) return 'the completion date';
  return (EVENT_TYPE_INFO as Record<string, EventTypeInfo>)[triggerType]?.trigger ?? triggerType.replaceAll('_', ' ');
}

export function isEventType(v: string): v is EventType {
  return (EVENT_TYPES as readonly string[]).includes(v);
}
