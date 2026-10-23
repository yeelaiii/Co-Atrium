import type { User } from '@supabase/supabase-js';

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'zh-Hans', label: '中文 (简体)' },
  { code: 'ta', label: 'தமிழ்' },
  { code: 'th', label: 'ไทย' },
  { code: 'bn', label: 'বাংলা' },
  { code: 'ms', label: 'Bahasa Melayu' },
] as const;

export const ROLES = [
  'Administrator',
  'Project Director',
  'Project Manager',
  'Quantity Surveyor',
  'Builder',
  'Sub Contractor',
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]['code'];
export type Role = (typeof ROLES)[number];

// Steps in order; the onboarding progress bar is derived from this.
export const ONBOARDING_STEPS = ['language', 'privacy', 'name', 'company', 'role', 'notifications'] as const;

export type OnboardingAnswers = {
  language: LanguageCode;
  privacyAccepted: boolean;
  displayName: string;
  companyName: string;
  role: Role | null;
};

/** Name suggested from the Google login, cleaned to satisfy the profiles.display_name constraint. */
export const suggestedDisplayName = (user: User | undefined) => {
  const meta = user?.user_metadata ?? {};
  const raw = [meta.full_name, meta.name, meta.display_name].find((v) => typeof v === 'string' && v.trim());
  return typeof raw === 'string' ? raw.replace(/[\p{Cc}<>]/gu, '').trim().slice(0, 80) : '';
};

// Stored in Supabase auth user_metadata so it follows the account across devices.
export const isOnboarded = (user: User | undefined) => !!user?.user_metadata?.onboarding_completed_at;
