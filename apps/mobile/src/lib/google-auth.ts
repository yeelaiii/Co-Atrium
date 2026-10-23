import {
  GoogleSignin,
  isErrorWithCode,
  isSuccessResponse,
  statusCodes,
} from '@react-native-google-signin/google-signin';

import { supabase } from './supabase';

GoogleSignin.configure({
  // Web client ID: this is what Supabase validates the ID token against, even on native.
  webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
  iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
});

/** Returns an error message to show the user, or null on success/cancel. */
export async function signInWithGoogle(): Promise<string | null> {
  try {
    await GoogleSignin.hasPlayServices();
    const response = await GoogleSignin.signIn();
    if (!isSuccessResponse(response)) return null; // user cancelled
    const idToken = response.data.idToken;
    if (!idToken) return 'Google did not return an ID token. Check the Web client ID.';

    const { error } = await supabase.auth.signInWithIdToken({ provider: 'google', token: idToken });
    return error ? error.message : null;
  } catch (error) {
    console.warn('Google sign-in failed', error);
    if (isErrorWithCode(error)) {
      if (error.code === statusCodes.IN_PROGRESS) return null;
      if (error.code === statusCodes.SIGN_IN_CANCELLED) return null;
      if (error.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) return 'Google Play Services is missing or out of date.';
      if (__DEV__) return `Sign-in failed (${error.code}): ${error.message}`;
    }
    return 'Something went wrong signing in. Please try again.';
  }
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
  await GoogleSignin.signOut().catch(() => {});
}
