export type MemberRole = 'owner' | 'member' | 'guest' | 'viewer';
export type InviteRole = Exclude<MemberRole, 'owner'>;

// Picker labels <-> database roles. Owner is not offered: it is granted by transferring ownership.
export const INVITE_ROLES: { role: InviteRole; label: string; description: string }[] = [
  { role: 'member', label: 'Member', description: 'Full access: messages, documents and the member list.' },
  { role: 'guest', label: 'Guest', description: 'Can post messages and see them from the day they join.' },
  { role: 'viewer', label: 'Viewer', description: 'Read-only, from the day they join.' },
];

// Must match the project_type_valid check in migration 0012.
export const PROJECT_TYPES = [
  'Residential',
  'Commercial',
  'Industrial',
  'Institutional',
  'Infrastructure',
  'Mixed-use',
  'Fit-out / Renovation',
  'Other',
] as const;

export const roleLabel = (role: string) => (role === 'owner' ? 'Owner' : INVITE_ROLES.find((r) => r.role === role)?.label ?? role);

// Mirrors the database check closely enough to catch typos; the RPC is the real validator.
export const isEmail = (value: string) => value.length <= 254 && /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(value);

/** Turns a Supabase/Postgres error from the invite RPCs into something to show the user. */
export function inviteErrorMessage(error: { code?: string; message?: string }): string {
  switch (error.code) {
    case '42501':
      return 'Only project owners can do this.';
    case '22023':
      return 'Enter a valid email address.';
    case '23505':
      return 'That person is already on this project.';
    case '54000':
      return error.message ?? 'Invite limit reached. Try again later.';
    default:
      return 'Something went wrong. Check your connection and try again.';
  }
}
