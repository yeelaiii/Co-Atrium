export type MemberRole = 'owner' | 'member' | 'guest' | 'viewer';
export type InviteRole = Exclude<MemberRole, 'owner'>;

// Picker labels <-> database roles. Owner is not offered: it is granted by transferring ownership.
export const INVITE_ROLES: { role: InviteRole; label: string; description: string }[] = [
  { role: 'member', label: 'Member', description: 'Full access: messages, documents and the member list.' },
  { role: 'guest', label: 'Guest', description: 'Can post messages and see them from the day they join.' },
  { role: 'viewer', label: 'Viewer', description: 'Read-only, from the day they join.' },
];

// A member's role on one project, chosen by the project's owners. Confirming roles can confirm
// contract values and verify deadline rules (while their access is owner or member). Must match
// job_role_valid, set_member_job_role() and private.is_confirming_role() in migration 0026.
export const JOB_ROLES = [
  { role: 'contract_admin', label: 'Contract administrator', confirms: true },
  { role: 'project_director', label: 'Project director', confirms: true },
  { role: 'project_manager', label: 'Project manager', confirms: true },
  { role: 'quantity_surveyor', label: 'Quantity surveyor', confirms: true },
  { role: 'site_supervisor', label: 'Site supervisor', confirms: false },
  { role: 'engineer', label: 'Engineer / consultant', confirms: false },
  { role: 'trades', label: 'Builder / trades', confirms: false },
  { role: 'administrator', label: 'Administrator', confirms: false },
] as const;
export type JobRole = (typeof JOB_ROLES)[number]['role'];

export const jobRoleLabel = (r: JobRole | null | undefined) => JOB_ROLES.find((x) => x.role === r)?.label ?? null;
export const isConfirmingRole = (r: JobRole | null | undefined) => !!JOB_ROLES.find((x) => x.role === r)?.confirms;

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

// Must match the project_status_valid check in migration 0013. Order is display order on the Projects tab.
export const PROJECT_STATUSES = [
  { status: 'ongoing', label: 'Ongoing' },
  { status: 'closed', label: 'Closed' },
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]['status'];

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
