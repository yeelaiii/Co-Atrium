import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { supabase } from '@/lib/supabase';
import { mapVoRow, voQuery, type VariationOrder } from '@/lib/variation-orders';

export type Transcript = { status: 'pending' | 'processing' | 'done' | 'failed'; text: string | null } | null;

export type ThreadAttachment = {
  id: string;
  kind: 'photo' | 'voice';
  path: string;
  durationMs: number | null;
  /** Voice notes only; null when no transcription was queued (e.g. over quota). */
  transcript: Transcript;
};

export type ThreadEntry = {
  id: string;
  kind: 'comment' | 'approval';
  authorId: string | null;
  authorName: string | null;
  body: string | null;
  createdAt: string;
  attachments: ThreadAttachment[];
};

type AttachmentRow = {
  id: string;
  kind: 'photo' | 'voice';
  storage_path: string;
  duration_ms: number | null;
  created_at: string;
  transcriptions: { status: NonNullable<Transcript>['status']; transcript: string | null }[] | { status: NonNullable<Transcript>['status']; transcript: string | null } | null;
};

const ATTACHMENT_SELECT = 'id, kind, storage_path, duration_ms, created_at, transcriptions(status, transcript)';

const mapAttachments = (rows: AttachmentRow[]): ThreadAttachment[] =>
  [...rows]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((a) => {
      // One transcription per attachment (unique constraint); PostgREST may return it as an object or a 1-item array.
      const t = Array.isArray(a.transcriptions) ? a.transcriptions[0] : a.transcriptions;
      return {
        id: a.id,
        kind: a.kind,
        path: a.storage_path,
        durationMs: a.duration_ms,
        transcript: t ? { status: t.status, text: t.transcript } : null,
      };
    });

/** One VO, the media sent with it, and its thread (comments and approval log lines), kept live. */
export function useVoThread(voId: string) {
  const [vo, setVo] = useState<VariationOrder | null>(null);
  const [opening, setOpening] = useState<ThreadAttachment[]>([]);
  const [entries, setEntries] = useState<ThreadEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(async () => {
    const [voRes, mediaRes, commentsRes] = await Promise.all([
      voQuery().eq('id', voId).maybeSingle(),
      supabase.from('variation_order_attachments').select(ATTACHMENT_SELECT).eq('variation_order_id', voId).is('comment_id', null),
      supabase
        .from('variation_order_comments')
        .select(`id, kind, author_id, body, created_at, author:profiles!author_id(display_name), variation_order_attachments(${ATTACHMENT_SELECT})`)
        .eq('variation_order_id', voId)
        .order('created_at', { ascending: true }),
    ]);
    const error = voRes.error || mediaRes.error || commentsRes.error;
    setFailed(!!error || !voRes.data);
    if (!error && voRes.data) {
      setVo(mapVoRow(voRes.data as never));
      setOpening(mapAttachments((mediaRes.data ?? []) as AttachmentRow[]));
      setEntries(
        ((commentsRes.data ?? []) as unknown as {
          id: string;
          kind: 'comment' | 'approval';
          author_id: string | null;
          body: string | null;
          created_at: string;
          author: { display_name: string | null } | null;
          variation_order_attachments: AttachmentRow[];
        }[]).map((c) => ({
          id: c.id,
          kind: c.kind,
          authorId: c.author_id,
          authorName: c.author?.display_name ?? null,
          body: c.body,
          createdAt: c.created_at,
          attachments: mapAttachments(c.variation_order_attachments ?? []),
        })),
      );
    }
    setLoading(false);
  }, [voId]);

  // Transcripts are not published over Realtime, so returning to the thread refetches them.
  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const later = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(reload, 250);
    };
    const channel = supabase
      .channel(`vo-thread:${voId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'variation_order_comments', filter: `variation_order_id=eq.${voId}` }, later)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'variation_order_approvers', filter: `variation_order_id=eq.${voId}` }, later)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'variation_orders', filter: `id=eq.${voId}` }, later)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'variation_order_participants', filter: `variation_order_id=eq.${voId}` }, later)
      .subscribe();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      supabase.removeChannel(channel);
    };
  }, [voId, reload]);

  return { vo, opening, entries, loading, failed, reload };
}
