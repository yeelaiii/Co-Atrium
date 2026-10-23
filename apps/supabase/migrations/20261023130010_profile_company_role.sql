-- =====================================================================
-- Migration 0010: company and job role on profiles (collected at onboarding)
-- Requires: 0002, 0006
-- =====================================================================

-- job_role is the person's profession. It is unrelated to project_members.role,
-- which is a per-project permission level. Both columns are nullable: profiles that
-- predate onboarding, and users who have not finished it, have neither.
alter table profiles
  add column company_name text,
  add column job_role text;

alter table profiles
  add constraint company_name_valid
    check (company_name is null
           or (char_length(company_name) between 1 and 80
               and company_name !~ '[[:cntrl:]<>]')),
  add constraint job_role_valid
    check (job_role is null
           or job_role in ('Administrator','Project Director','Project Manager',
                           'Quantity Surveyor','Builder','Sub Contractor'));

-- Users edit these on their own row only (existing "update own profile" policy).
grant update (company_name, job_role) on profiles to authenticated;
