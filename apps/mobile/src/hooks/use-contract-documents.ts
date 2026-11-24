import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { type ContractDocument, type ExtractedField, type ExtractionFinding } from '@/lib/contract-documents';
import { requestRecalculation } from '@/lib/deadlines';
import { channelName } from '@/lib/realtime';
import { supabase } from '@/lib/supabase';

/** A project's contract documents, with extraction status live through Realtime. */
export function useContractDocuments(projectId: string) {
  const [documents, setDocuments] = useState<ContractDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(async () => {
    const { data, error } = await supabase
      .from('contract_documents')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });
    setFailed(!!error);
    if (!error) setDocuments((data ?? []) as ContractDocument[]);
    setLoading(false);
  }, [projectId]);

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const later = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(reload, 300);
    };
    const channel = supabase
      .channel(channelName(`contract_documents:${projectId}`))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'contract_documents', filter: `project_id=eq.${projectId}` }, later)
      .subscribe();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      supabase.removeChannel(channel);
    };
  }, [projectId, reload]);

  const toReview = useMemo(() => documents.filter((d) => d.extraction_status === 'needs_review').length, [documents]);
  const working = useMemo(() => documents.some((d) => d.extraction_status === 'queued' || d.extraction_status === 'processing'), [documents]);

  return { documents, loading, failed, reload, toReview, working };
}

/**
 * Open proposals (status 'proposed') and unchanged values ('no_change') for the project, newest
 * document first, plus open findings. Confirming goes through RPCs that check the contract role.
 */
export function useExtractedFields(projectId: string, documentId?: string) {
  const [fields, setFields] = useState<ExtractedField[]>([]);
  const [findings, setFindings] = useState<ExtractionFinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(async () => {
    let f = supabase.from('extracted_fields').select('*').eq('project_id', projectId).in('status', ['proposed', 'no_change']);
    let x = supabase.from('extraction_findings').select('*').eq('project_id', projectId).eq('status', 'open').neq('kind', 'suspected_invention');
    if (documentId) {
      f = f.eq('document_id', documentId);
      x = x.eq('document_id', documentId);
    }
    const [fr, xr] = await Promise.all([f.order('created_at', { ascending: false }), x.order('page_no')]);
    setFailed(!!(fr.error || xr.error));
    if (!fr.error) setFields((fr.data ?? []) as ExtractedField[]);
    if (!xr.error) setFindings((xr.data ?? []) as ExtractionFinding[]);
    setLoading(false);
  }, [projectId, documentId]);

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  const run = useCallback(
    async (fn: string, args: Record<string, unknown>) => {
      const { data, error } = await supabase.rpc(fn, args);
      await reload();
      if (!error) requestRecalculation(projectId);
      return { data, error };
    },
    [projectId, reload],
  );

  return {
    fields,
    findings,
    loading,
    failed,
    reload,
    confirm: (fid: string, edited?: unknown, notStated = false) =>
      run('confirm_extracted_field', { fid, edited: edited === undefined ? null : edited, not_stated: notStated }).then((r) => r.error),
    confirmMany: (fids: string[]) => run('confirm_extracted_fields', { fids }),
    reject: (fid: string) => run('reject_extracted_field', { fid }).then((r) => r.error),
    dismissFinding: (xid: string) => run('dismiss_extraction_finding', { xid }).then((r) => r.error),
  };
}
