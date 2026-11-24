import { requiredFieldsStatus } from '@shared/contracts/contractFieldSchema.ts';
import { buildCalendar, type CalendarSettings } from '@shared/deadlines/calendar.ts';
import type { Party } from '@shared/deadlines/rules.ts';
import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';

import { type ContractRole, type DeadlineRule, requestRecalculation } from '@/lib/deadlines';
import type { MemberRole } from '@/lib/projects';
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

/**
 * A project's confirmed contract fields and deadline rules, whether deadlines are live, and
 * whether the signed-in user may confirm (owner/member with a contract role, migration 0019).
 */
export function useContract(projectId: string) {
  const { session } = useAuth();
  const me = session?.user.id;
  const [fields, setFields] = useState<Map<string, ContractField>>(new Map());
  const [rules, setRules] = useState<DeadlineRule[]>([]);
  const [settings, setSettings] = useState<DeadlineSettings | null>(null);
  const [role, setRole] = useState<{ role: MemberRole; contract_role: ContractRole | null; contract_party: Party | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(async () => {
    if (!me) return;
    const [f, r, s, m] = await Promise.all([
      supabase.from('project_contract_fields').select('field_key, value, not_stated, origin, source_page, source_excerpt, confirmed_at').eq('project_id', projectId),
      supabase.from('deadline_rules').select('*').eq('project_id', projectId).order('rule_key'),
      supabase.from('project_deadline_settings').select('service_cutoff, saturday_is_working_day, high_confidence_threshold').eq('project_id', projectId).maybeSingle(),
      supabase.from('project_members').select('role, contract_role, contract_party').eq('project_id', projectId).eq('user_id', me).is('left_at', null).maybeSingle(),
    ]);
    setFailed(!!(f.error || r.error));
    if (!f.error) setFields(new Map(((f.data ?? []) as ContractField[]).map((x) => [x.field_key, x])));
    if (!r.error) setRules((r.data ?? []) as DeadlineRule[]);
    if (!s.error) setSettings((s.data as DeadlineSettings | null) ?? null);
    setRole((m.data as typeof role) ?? null);
    setLoading(false);
  }, [projectId, me]);

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  const status = useMemo(() => requiredFieldsStatus(new Set(fields.keys())), [fields]);
  const canConfirm = !!role && (role.role === 'owner' || role.role === 'member') && !!role.contract_role;
  const isStaff = !!role && (role.role === 'owner' || role.role === 'member');

  /** Runs an RPC, reloads, and asks the server to recompute deadlines. Resolves to the error, if any. */
  const run = useCallback(
    async (fn: string, args: Record<string, unknown>) => {
      const { error } = await supabase.rpc(fn, args);
      if (!error) {
        await reload();
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
 * the shared engine so the app shows the same "served on" date the server will use.
 */
export function useDeadlineCalendar(projectId: string): CalendarSettings | null {
  const [cal, setCal] = useState<CalendarSettings | null>(null);
  useFocusEffect(
    useCallback(() => {
      let live = true;
      Promise.all([
        supabase.from('public_holidays').select('date'),
        supabase.from('project_deadline_settings').select('service_cutoff, saturday_is_working_day').eq('project_id', projectId).maybeSingle(),
      ]).then(([h, s]) => {
        if (!live || h.error) return;
        setCal(
          buildCalendar({
            holidays: (h.data ?? []).map((x: { date: string }) => x.date),
            saturdayIsWorkingDay: s.data?.saturday_is_working_day ?? false,
            serviceCutoff: s.data?.service_cutoff ? String(s.data.service_cutoff).slice(0, 5) : '17:00',
          }),
        );
      });
      return () => {
        live = false;
      };
    }, [projectId]),
  );
  return cal;
}
