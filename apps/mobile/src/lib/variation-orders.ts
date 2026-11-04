import { File } from 'expo-file-system';

import { supabase } from '@/lib/supabase';

export type Approver = { userId: string | null; name: string | null; approvedAt: string | null };
/** Someone the VO is shared with (the sender, people they included, and every approver). */
export type Participant = { userId: string; name: string | null };

export type VariationOrder = {
  id: string;
  projectId: string;
  number: number;
  name: string;
  location: string | null;
  requestedBy: string;
  description: string | null;
  sentAt: string;
  sentById: string | null;
  sentByName: string | null;
  status: 'pending' | 'approved';
  approvedAt: string | null;
  approvers: Approver[];
  participants: Participant[];
  /** Storage paths of the photos sent with the VO (not those added later in the thread). */
  photos: string[];
};

/** Where a VO sits for the signed-in user. */
export type VoBucket = 'pending' | 'yours' | 'completed';

// Display order of the list view and the triage view.
export const VO_BUCKETS: { bucket: VoBucket; label: string }[] = [
  { bucket: 'pending', label: 'Pending approval' },
  { bucket: 'yours', label: 'Pending your approval' },
  { bucket: 'completed', label: 'Completed' },
];

export const voBucket = (vo: VariationOrder, me: string | undefined): VoBucket => {
  if (vo.status === 'approved') return 'completed';
  if (me && vo.approvers.some((a) => a.userId === me && !a.approvedAt)) return 'yours';
  return 'pending';
};

/** VOs in bucket order, newest first within each bucket. */
export function sortVariationOrders(list: VariationOrder[], me: string | undefined) {
  const rank = (vo: VariationOrder) => VO_BUCKETS.findIndex((b) => b.bucket === voBucket(vo, me));
  return [...list].sort((a, b) => rank(a) - rank(b) || b.sentAt.localeCompare(a.sentAt));
}

export const voCode = (vo: Pick<VariationOrder, 'number'>) => `VO-${vo.number}`;

export const approvalProgress = (vo: VariationOrder) => {
  const done = vo.approvers.filter((a) => a.approvedAt).length;
  return { done, total: vo.approvers.length };
};

// ---------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------

export const VO_SELECT = `id, project_id, number, name, location, requested_by, description, sent_at, sent_by, status, approved_at,
  sender:profiles!sent_by(display_name),
  variation_order_approvers(user_id, approved_at, created_at, profile:profiles!user_id(display_name)),
  variation_order_participants(user_id, created_at, profile:profiles!user_id(display_name)),
  variation_order_attachments(storage_path, kind, comment_id, created_at)`;

type VoRow = {
  id: string;
  project_id: string;
  number: number;
  name: string;
  location: string | null;
  requested_by: string;
  description: string | null;
  sent_at: string;
  sent_by: string | null;
  status: 'pending' | 'approved';
  approved_at: string | null;
  sender: { display_name: string | null } | null;
  variation_order_approvers: {
    user_id: string | null;
    approved_at: string | null;
    created_at: string;
    profile: { display_name: string | null } | null;
  }[];
  variation_order_participants: { user_id: string; created_at: string; profile: { display_name: string | null } | null }[];
  variation_order_attachments: { storage_path: string; kind: string; comment_id: string | null; created_at: string }[];
};

export function mapVoRow(row: VoRow): VariationOrder {
  return {
    id: row.id,
    projectId: row.project_id,
    number: row.number,
    name: row.name,
    location: row.location,
    requestedBy: row.requested_by,
    description: row.description,
    sentAt: row.sent_at,
    sentById: row.sent_by,
    sentByName: row.sender?.display_name ?? null,
    status: row.status,
    approvedAt: row.approved_at,
    approvers: [...row.variation_order_approvers]
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((a) => ({ userId: a.user_id, name: a.profile?.display_name ?? null, approvedAt: a.approved_at })),
    participants: [...(row.variation_order_participants ?? [])]
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((p) => ({ userId: p.user_id, name: p.profile?.display_name ?? null })),
    photos: row.variation_order_attachments
      .filter((a) => a.kind === 'photo' && !a.comment_id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((a) => a.storage_path),
  };
}

/** VO-level photos only: attachments posted later in the thread are left out of the embed. */
export const voQuery = () =>
  supabase
    .from('variation_orders')
    .select(VO_SELECT)
    .is('variation_order_attachments.comment_id', null)
    .eq('variation_order_attachments.kind', 'photo');

// ---------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------

export type LocalPhoto = { kind: 'photo'; uri: string; mimeType: string };
export type LocalVoice = { kind: 'voice'; uri: string; durationMs: number };
export type LocalAttachment = LocalPhoto | LocalVoice;

const uniqueName = (ext: string) =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}.${ext}`;

const extFor = (mime: string) => (mime === 'image/png' ? 'png' : mime === 'image/heic' ? 'heic' : mime === 'image/webp' ? 'webp' : 'jpg');

/**
 * Uploads local photos / voice notes to storage and returns the JSON the VO RPCs expect.
 * Paths are '<project id>/<unique name>' (enforced by the database).
 */
export async function uploadAttachments(projectId: string, items: LocalAttachment[]) {
  return Promise.all(
    items.map(async (item) => {
      const isPhoto = item.kind === 'photo';
      const mime = isPhoto ? item.mimeType : 'audio/mp4';
      const path = `${projectId}/${uniqueName(isPhoto ? extFor(mime) : 'm4a')}`;
      const body = await new File(item.uri).arrayBuffer();
      const { error } = await supabase.storage
        .from(isPhoto ? 'attachments' : 'audio')
        .upload(path, body, { contentType: mime, upsert: false });
      if (error) throw error;
      return isPhoto ? { kind: 'photo', path } : { kind: 'voice', path, duration_ms: Math.round(item.durationMs) };
    }),
  );
}

// ---------------------------------------------------------------------
// Validation (mirrors the table constraints in migration 0014)
// ---------------------------------------------------------------------

export const cleanLine = (value: string, max: number) => value.length <= max && !/[\p{Cc}<>]/u.test(value);
export const cleanMultiline = (value: string, max: number) => value.length <= max && !/[^\P{Cc}\t\n\r]|[<>]/u.test(value);

/** Turns an error from the VO RPCs or uploads into something to show the user. */
export function voErrorMessage(error: unknown): string {
  const { code, message } = (error ?? {}) as { code?: string; message?: string };
  switch (code) {
    case '42501':
      return message ?? 'You do not have permission to do this.';
    case '22023':
    case '23505':
    case '54000':
      return message ?? 'That could not be saved.';
    case 'P0002':
      return 'This variation order is no longer available.';
    case '23514':
      return 'Some details are too long or contain characters that are not allowed.';
    default:
      return 'Something went wrong. Check your connection and try again.';
  }
}

// ---------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------

/** "Today, 3:41 pm", "Yesterday, 9:05 am", or "4 Nov 2026, 3:41 pm". */
export function formatSentAt(iso: string) {
  const date = new Date(iso);
  const now = new Date();
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  const day = date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() !== now.getFullYear() && { year: 'numeric' }),
  });
  return `${day}, ${time}`;
}

export const formatDuration = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};
