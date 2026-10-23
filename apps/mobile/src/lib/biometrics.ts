import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

const ENABLED_KEY = 'biometric_lock_enabled';

/** True when the device has biometric hardware with at least one enrolled face/fingerprint. */
export async function biometricsAvailable(): Promise<boolean> {
  const [hardware, enrolled] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
  ]);
  return hardware && enrolled;
}

export async function readBiometricPreference(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(ENABLED_KEY)) === '1';
  } catch {
    return false;
  }
}

export async function writeBiometricPreference(enabled: boolean): Promise<void> {
  if (enabled) await SecureStore.setItemAsync(ENABLED_KEY, '1');
  else await SecureStore.deleteItemAsync(ENABLED_KEY);
}

/** Prompts for Face ID / fingerprint, falling back to the device passcode. */
export async function promptBiometrics(promptMessage: string): Promise<boolean> {
  const result = await LocalAuthentication.authenticateAsync({ promptMessage, cancelLabel: 'Cancel' });
  return result.success;
}
