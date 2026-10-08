-- =====================================================================
-- Migration 0002: tables, indexes, RLS enabled, base revokes
-- Requires: 0001
-- =====================================================================

-- =====================================================================
-- 2. TABLES
-- =====================================================================

create table profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),

  constraint display_name_valid
    check (display_name is null
           or (char_length(display_name) between 1 and 80
               and display_name !~ '[[:cntrl:]<>]'))
);

-- Account deletion anonymises authored content: created_by becomes NULL.
create table projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint project_name_valid
    check (char_length(btrim(name)) between 1 and 120)
);

create table project_members (
  project_id uuid not null references projects on delete cascade,
  user_id uuid not null references profiles on delete cascade,
  role text not null default 'member'
    check (role in ('owner','member','guest','viewer')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (project_id, user_id)
);

-- Append-only audit trail (written by trigger). Replaces overwriting joined_at as history.
create table membership_events (
  id bigint generated always as identity primary key,
  project_id uuid not null references projects on delete cascade,
  user_id uuid references profiles on delete set null,
  actor_id uuid references profiles on delete set null,
  event text not null check (event in ('joined','rejoined','left','role_changed')),
  role text,
  created_at timestamptz not null default now()
);

-- Membership is consensual: owners invite, the invitee accepts.
create table project_invites (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  invited_user_id uuid not null references profiles on delete cascade,
  invited_by uuid references profiles on delete set null,
  role text not null default 'member' check (role in ('member','guest','viewer')),
  status text not null default 'pending'
    check (status in ('pending','accepted','declined','revoked')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  responded_at timestamptz
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  sender_id uuid default auth.uid() references profiles(id) on delete set null,
  body text,
  attachment_path text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,                 -- tombstone: body/attachment are scrubbed

  constraint message_not_empty
    check (deleted_at is not null
           or nullif(btrim(body), '') is not null
           or attachment_path is not null),
  constraint message_body_length
    check (body is null or char_length(body) <= 4000),
  constraint attachment_path_valid
    check (attachment_path is null
           or private.path_project_id(attachment_path) = project_id)
);

create table documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  title text not null,
  content jsonb,
  version integer not null default 1,     -- optimistic concurrency (see update_document)
  created_by uuid default auth.uid() references profiles(id) on delete set null,
  updated_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint document_title_valid
    check (char_length(btrim(title)) between 1 and 200),
  constraint document_content_size
    check (content is null or octet_length(content::text) <= 1000000)
);

-- Transcriptions are personal data of the requester: cascade on account deletion.
create table transcriptions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  user_id uuid not null default auth.uid() references profiles(id) on delete cascade,
  audio_path text not null,
  status text not null default 'pending'
    check (status in ('pending','processing','done','failed')),
  transcript text,
  error text,
  attempts integer not null default 0 check (attempts >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint audio_path_valid
    check (private.path_project_id(audio_path) = project_id),
  constraint transcription_error_length
    check (error is null or char_length(error) <= 1000)
);


-- =====================================================================
-- 3. INDEXES
-- =====================================================================

-- project_members
create index on project_members (user_id);                       -- FK / cascade from profiles
create index on project_members (user_id, project_id) include (role)
  where left_at is null;                                         -- RLS helpers (active only)
create unique index one_pending_invite_per_user
  on project_invites (project_id, invited_user_id) where status = 'pending';
create index on project_invites (invited_user_id) where status = 'pending';
create index on project_invites (invited_by, created_at desc);   -- invite rate limit
create index on membership_events (project_id, created_at desc);

-- projects
create index on projects (created_by);

-- messages
create index on messages (project_id, created_at desc);
create index on messages (sender_id, created_at desc);           -- FK, rate limit, guest profile lookup
create index on messages (attachment_path) where attachment_path is not null;  -- storage policy

-- documents
create index on documents (project_id, updated_at desc) where deleted_at is null;
create index on documents (created_by);
create index on documents (updated_by);

-- transcriptions
create index on transcriptions (user_id, created_at desc);
create index on transcriptions (project_id, created_at desc);
create index on transcriptions (status, updated_at) where status in ('pending','processing');  -- reaper



-- =====================================================================
-- RLS ON + NO PRIVILEGES until policies/grants arrive in 0006
-- (tables are deny-all in the meantime, never exposed)
-- =====================================================================

alter table profiles           enable row level security;
alter table projects           enable row level security;
alter table project_members    enable row level security;
alter table membership_events  enable row level security;
alter table project_invites    enable row level security;
alter table messages           enable row level security;
alter table documents          enable row level security;
alter table transcriptions     enable row level security;

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
