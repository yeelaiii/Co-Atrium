import { requiredFieldsStatus } from '@shared/contracts/contractFieldSchema.ts';
import { buildCalendar, type CalendarSettings } from '@shared/deadlines/calendar.ts';
import type { Party } from '@shared/deadlines/rules.ts';
import { useCallback, useMemo } from 'react';

import { type ContractRole, type DeadlineRule, requestRecalculation } from '@/lib/deadlines';
import type { MemberRole } from '@/lib/projects';
import { invalidateQueries, MINUTE, useCachedQuery } from '@/lib/query-cache';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/AuthProvider';

export type ContractField = {
  field_key: string;
  value: unknown;
  not_stated: boolean;
  origin: 'extracted' | 'standard_form_default' | 'user_entered';
  source_page: number | null;
  source_excerpt: string | null;
  confirmed_at: string;
};

export type DeadlineSettings = {
  service_cutoff: string;
  saturday_is_working_day: boolean;
  /** "Accept all high-confidence" threshold for extracted values (migration 0020, default 0.9). */
  high_confidence_threshold: number;
};

type MyContractRole = { role: MemberRole; contract_role: ContractRole | null; contract_party: Party | null };
type ContractData = {
  fields: Map<string, ContractField>;
  rules: DeadlineRule[];
  settings: DeadlineSettings | null;
  role: MyContractRole | null;
  failed: boolean;
};
const EMPTY_FIELDS = new Map<string, ContractField>();
const EMPTY_RULES: DeadlineRule[] = [];

/**
 * A project's confirmed contract fields and deadline rules, whether deadlines are live, and
 * whether the signed-in user may confirm (owner/member with a contract role, migration 0019).
 * Cached for a minute and shared by every contract/deadline screen of the project.
 */
export function useContract(projectId: string) {
  const { session } = useAuth();
  const me = session?.user.id;

  const { data, loading, reload } = useCachedQuery<ContractData>(
    me ? `project:${projectId}:contract:${me}` : null,
    async (prev) => {
      const [f, r, s, m] = await Promise.all([
        supabase.from('project_contract_fields').select('field_key, value, not_stated, origin, source_page, source_excerpt, confirmed_at').eq('project_id', projectId),
        supabase.from('deadline_rules').select('*').eq('project_id', projectId).order('rule_key'),
        supabase.from('project_deadline_settings').select('service_cutoff, saturday_is_working_day, high_confidence_threshold').eq('project_id', projectId).maybeSingle(),
        supabase.from('project_members').select('role, contract_role, contract_party').eq('project_id', projectId).eq('user_id', me!).is('left_at', null).maybeSingle(),
      ]);
      return {
        fields: f.error ? (prev?.fields ?? EMPTY_FIELDS) : new Map(((f.data ?? []) as ContractField[]).map((x) => [x.field_key, x])),
        rules: r.error ? (prev?.rules ?? EMPTY_RULES) : ((r.data ?? []) as DeadlineRule[]),
        settings: s.error ? (prev?.settings ?? null) : ((s.data as DeadlineSettings | null) ?? null),
        role: (m.data as MyContractRole | null) ?? null,
        failed: !!(f.error || r.error),
      };
    },
    { staleTime: MINUTE },
  );

  const fields = data?.fields ?? EMPTY_FIELDS;
  const rules = data?.rules ?? EMPTY_RULES;
  const settings = data?.settings ?? null;
  const role = data?.role ?? null;
  const failed = data?.failed ?? false;

  const status = useMemo(() => requiredFieldsStatus(new Set(fields.keys())), [fields]);
  const canConfirm = !!role && (role.role === 'owner' || role.role === 'member') && !!role.contract_role;
  const isStaff = !!role && (role.role === 'owner' || role.role === 'member');

  /** Runs an RPC, reloads, and asks the server to recompute deadlines. Resolves to the error, if any. */
  const run = useCallback(
    async (fn: string, args: Record<string, unknown>) => {
      const { error } = await supabase.rpc(fn, args);
      if (!error) {
        await reload();
        // Settings feed the working-day calendar.
        invalidateQueries(`project:${projectId}:calendar`);
        requestRecalculation(projectId);
      }
      return error;
    },
    [projectId, reload],
  );

  return {
    fields,
    rules,
    settings,
    loading,
    failed,
    reload,
    live: status.complete,
    missing: status.missing,
    canConfirm,
    isStaff,
    myParty: role?.contract_party ?? null,
    setField: (key: string, value: unknown, notStated = false) =>
      run('set_contract_field', { pid: projectId, fkey: key, new_value: notStated ? null : value, is_not_stated: notStated }),
    updateRule: (rid: string, patch: Record<string, unknown>) => run('update_deadline_rule', { rid, patch }),
    verifyRule: (rid: string) => run('verify_deadline_rule', { rid }),
    rejectRule: (rid: string) => run('reject_deadline_rule', { rid }),
    createRule: (rule: Record<string, unknown>) => run('create_deadline_rule', { pid: projectId, rule }),
    updateSettings: (cutoff: string, saturday: boolean) =>
      run('update_deadline_settings', { pid: projectId, cutoff, saturday_working: saturday, schedule: null }),
  };
}

/**
 * The project's working-day calendar (Singapore public holidays + service cut-off), built with
 * the shared engine so the app shows the same "served on" date the server will use. Public
 * holidays change about once a year, so they are cached for the session.
 */
export function useDeadlineCalendar(projectId: string): CalendarSettings | null {
  const holidays = useCachedQuery<string[] | null>(
    'public-holidays',
    async (prev) => {
      const { data, error } = await supabase.from('public_holidays').select('date');
      return error ? (prev ?? null) : (data ?? []).map((x: { date: string }) => x.date);
    },
    { staleTime: 24 * 60 * MINUTE },
  ).data;
  const settings = useCachedQuery<{ saturday: boolean; cutoff: string } | null>(
    `project:${projectId}:calendar`,
    async (prev) => {
      const { data, error } = await supabase
        .from('project_deadline_settings')
        .select('service_cutoff, saturday_is_working_day')
        .eq('project_id', projectId)
        .maybeSingle();
      if (error) return prev ?? null;
      return {
        saturday: data?.saturday_is_working_day ?? false,
        cutoff: data?.service_cutoff ? String(data.service_cutoff).slice(0, 5) : '17:00',
      };
    },
    { staleTime: 5 * MINUTE },
  ).data;

  return useMemo(
    () =>
      holidays && settings !== undefined
        ? buildCalendar({ holidays, saturdayIsWorkingDay: settings?.saturday ?? false, serviceCutoff: settings?.cutoff ?? '17:00' })
        : null,
    [holidays, settings],
  );
}
