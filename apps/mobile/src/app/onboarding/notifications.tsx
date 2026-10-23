import { useState } from 'react';

import { NotificationPrompt } from '@/components/NotificationPrompt';
import { supabase } from '@/lib/supabase';
import { useOnboarding } from '@/providers/OnboardingProvider';

export default function NotificationsStep() {
  const { answers } = useOnboarding();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The completion flag is written last: it updates the session, and the root layout then moves on to
  // the app. If anything fails before it, the user simply retries this step.
  const finish = async () => {
    setBusy(true);
    setError(null);
    const { data } = await supabase.auth.getUser();
    const saved = data.user
      ? await supabase
          .from('profiles')
          .update({ company_name: answers.companyName.trim(), job_role: answers.role })
          .eq('id', data.user.id)
      : { error: new Error('Not signed in') };
    const completed = saved.error
      ? saved
      : await supabase.auth.updateUser({
          data: {
            language: answers.language,
            privacy_accepted_at: new Date().toISOString(),
            onboarding_completed_at: new Date().toISOString(),
          },
        });
    if (completed.error) setError('Could not save your details. Check your connection and try again.');
    setBusy(false);
  };

  return <NotificationPrompt onContinue={finish} busy={busy} error={error} />;
}
