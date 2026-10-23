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
export const ONBOARDING_STEPS = ['language', 'privacy', 'company', 'role', 'notifications'] as const;

export type OnboardingAnswers = {
  language: LanguageCode;
  privacyAccepted: boolean;
  companyName: string;
  role: Role | null;
};

// Stored in Supabase auth user_metadata so it follows the account across devices.
export const isOnboarded = (user: User | undefined) => !!user?.user_metadata?.onboarding_completed_at;
