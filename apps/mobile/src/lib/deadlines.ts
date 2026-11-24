// Client side of contracts and deadlines: labels, row types and RPC wrappers.
// Date maths and field schemas come from the shared engine (@shared), also used by the Edge Functions.

import { File } from 'expo-file-system';

import { EVENT_TYPE_INFO, type EventType } from '@shared/contracts/eventTypes.ts';
import { type Party, type PeriodUnit, unitLabel } from '@shared/deadlines/index.ts';

import { supabase } from '@/lib/supabase';

export type ContractRole = 'qs' | 'pm' | 'contract_admin';

// Must match contract_role_valid / contract_party_valid (migration 0019).
export const CONTRACT_ROLES: { role: ContractRole; label: string }[] = [
  { role: 'qs', label: 'Quantity surveyor' },
  { role: 'pm', label: 'Project manager' },
  { role: 'contract_admin', label: 'Contract administrator' },
];
export const PARTY_LABEL: Record<Party, string> = {
  employer: 'Employer',
  contract_admin: 'Contract administrator',
  contractor: 'Contractor',
  subcontractor: 'Subcontractor',
  qs: 'Quantity surveyor',
  consultant: 'Consultant',
};
export const PARTIES = Object.keys(PARTY_LABEL) as Party[];

export const contractRoleLabel = (r: ContractRole | null | undefined) => CONTRACT_ROLES.find((x) => x.role === r)?.label ?? null;

export const DISCLAIMER =
  'Deadlines and extracted values are an aid only. Check them against your contract. This is not legal advice.';

export type ObligationStatus = 'open' | 'met' | 'overdue' | 'waived' | 'suggested';

export type Obligation = {
  id: string;
  project_id: string;
  rule_id: string;
  rule_key: string;
  group_key: string;
  kind: 'action' | 'milestone';
  anchor: 'event' | 'completion_date' | 'chained' | 'variation';
  trigger_event_id: string | null;
  parent_obligation_id: string | null;
  variation_order_id: string | null;
  obligation: string;
  reminder_label: string;
  subject: string | null;
  responsible_party: Party;
  recipient_party: Party;
  due_at: string;
  due_date: string;
  explanation: string;
  period: number;
  unit: PeriodUnit;
  source_label: string;
  is_time_bar: boolean;
  status: ObligationStatus;
  closed_by_event_id: string | null;
  closed_at: string | null;
  close_note: string | null;
  created_at: string;
};

export type ProjectEvent = {
  id: string;
  project_id: string;
  event_type: EventType;
  reference: string | null;
  raised_by_party: Party | null;
  addressed_to_party: Party | null;
  sent_at: string;
  served_at: string | null;
  time_extension_days: number | null;
  variation_order_id: string | null;
  related_event_id: string | null;
  attachments: string[];
  notes: string | null;
  created_by: string | null;
  created_at: string;
  voided_at: string | null;
};

export type DeadlineRule = {
  id: string;
  rule_key: string;
  group_key: string;
  kind: 'action' | 'milestone';
  obligation: string;
  reminder_label: string;
  responsible_role: Party;
  recipient_role: Party;
  trigger_event_type: string;
  period: number | null;
  unit: PeriodUnit | null;
  period_field: string | null;
  default_period: number | null;
  includes_public_holidays: boolean | null;
  cap_days: number | null;
  cap_label: string | null;
  is_time_bar: boolean | null;
  consequence: string | null;
  origin: 'statute' | 'standard_form_default' | 'amended' | 'project_procedure' | 'user_defined';
  source_clause: string | null;
  source_page: number | null;
  /** The contract document an amended / procedure rule was extracted from (migration 0024). */
  source_document_id: string | null;
  confidence: number | null;
  todo_verify: string[];
  closed_by_event_types: string[];
  chains_to: string[];
  status: 'draft' | 'verified' | 'rejected';
  verified_at: string | null;
};

export const ORIGIN_LABEL: Record<DeadlineRule['origin'], string> = {
  statute: 'Statute',
  standard_form_default: 'Standard form',
  amended: 'Amended by contract',
  project_procedure: 'Project procedure',
  user_defined: 'Entered by user',
};

export const TODO_LABEL: Record<string, string> = {
  period: 'period',
  unit: 'unit',
  includes_public_holidays: 'public holidays',
  is_time_bar: 'time bar',
  clause_ref: 'clause',
};

export function eventLabel(t: string): string {
  return (EVENT_TYPE_INFO as Record<string, { label: string }>)[t]?.label ?? t.replaceAll('_', ' ');
}

export function periodText(period: number | null, unit: PeriodUnit | null): string | null {
  if (period === null || !unit) return null;
  return `${period} ${unitLabel(unit, period)}`;
}

/** Rule's period in words: "7 working days", "contract period (payment response period), else 14 calendar days". */
export function rulePeriodText(r: DeadlineRule, fieldLabel: (k: string) => string): string {
  if (r.todo_verify.includes('period') || r.todo_verify.includes('unit')) return 'TODO_VERIFY';
  const own = periodText(r.period, r.unit);
  if (own) return own + (r.cap_days !== null ? `, capped at ${r.cap_days} calendar days` : '');
  const parts: string[] = [];
  if (r.period_field) parts.push(`from contract: ${fieldLabel(r.period_field)}`);
  if (r.default_period !== null && r.unit) parts.push(`else ${periodText(r.default_period, r.unit)}`);
  if (r.cap_days !== null) parts.push(`capped at ${r.cap_days} calendar days`);
  return parts.join(', ') || 'No period';
}

/** Turns Postgres / Edge Function errors into a sentence for the user. */
export function deadlineErrorMessage(e: unknown): string {
  const err = e as { code?: string; message?: string } | null;
  if (err?.code === '42501') return err.message || 'You do not have permission to do that.';
  if (err?.code === '22023' || err?.code === 'P0002' || err?.code === '54000') return err.message ?? 'That could not be saved.';
  return 'That could not be saved. Check your connection and try again.';
}

const uniqueName = (ext: string) =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}.${ext}`;

export type LocalFile = { uri: string; mimeType: string; name: string };

/** Uploads event attachments (photos, screenshots, files) to the 'attachments' bucket. Returns their paths. */
export async function uploadEventFiles(projectId: string, files: LocalFile[]): Promise<string[]> {
  return Promise.all(
    files.map(async (f) => {
      const ext = (f.name.split('.').pop() ?? 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
      const path = `${projectId}/${uniqueName(ext)}`;
      const body = await new File(f.uri).arrayBuffer();
      const { error } = await supabase.storage.from('attachments').upload(path, body, { contentType: f.mimeType, upsert: false });
      if (error) throw error;
      return path;
    }),
  );
}

/** After logging an event: ask the server to create its obligations now (cron catches up otherwise). */
export async function requestObligations(projectId: string) {
  await supabase.functions.invoke('create-obligations', { body: { project_id: projectId } }).catch(() => {});
}

/** After changing fields, rules or settings: recompute deadlines. Returns live status. */
export async function requestRecalculation(projectId: string): Promise<{ live: boolean; missing: string[] } | null> {
  const { data, error } = await supabase.functions.invoke('recalculate-deadlines', { body: { project_id: projectId } });
  if (error) return null;
  return data as { live: boolean; missing: string[] };
}
