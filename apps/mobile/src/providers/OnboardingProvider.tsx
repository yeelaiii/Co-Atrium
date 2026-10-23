import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import { suggestedDisplayName, type OnboardingAnswers } from '@/lib/onboarding';
import { useAuth } from '@/providers/AuthProvider';

type OnboardingState = {
  answers: OnboardingAnswers;
  update: (patch: Partial<OnboardingAnswers>) => void;
};

const OnboardingContext = createContext<OnboardingState | null>(null);

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const [answers, setAnswers] = useState<OnboardingAnswers>({
    language: 'en',
    privacyAccepted: false,
    displayName: suggestedDisplayName(session?.user),
    companyName: '',
    role: null,
  });
  const value = useMemo(
    () => ({ answers, update: (patch: Partial<OnboardingAnswers>) => setAnswers((a) => ({ ...a, ...patch })) }),
    [answers],
  );
  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

export function useOnboarding() {
  const ctx = useContext(OnboardingContext);
  if (!ctx) throw new Error('useOnboarding must be used inside OnboardingProvider');
  return ctx;
}
