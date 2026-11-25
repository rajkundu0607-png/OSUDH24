import {getApps, initializeApp} from 'firebase/app';
import {getAuth, GoogleAuthProvider, inMemoryPersistence, setPersistence, signInWithPopup, signOut, type Auth} from 'firebase/auth';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

function googleError(cause: unknown): Error {
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? String(cause.code) : '';
  const messages: Record<string, string> = {
    'auth/popup-blocked': 'Your browser blocked the Google sign-in window. Allow popups for this site and try again.',
    'auth/popup-closed-by-user': 'The Google sign-in window was closed. You can try again.',
    'auth/cancelled-popup-request': 'Another sign-in window was opened. Close it and try again.',
    'auth/unauthorized-domain': 'Google sign-in is not enabled for this website address yet.',
    'auth/operation-not-allowed': 'Google sign-in has not been enabled for this store yet.',
    'auth/network-request-failed': 'Google sign-in could not connect. Check your connection and try again.',
    'auth/invalid-api-key': 'Google sign-in is not configured correctly yet.',
    'auth/configuration-not-found': 'Google sign-in is not configured correctly yet.',
    'auth/app-not-authorized': 'Google sign-in is not enabled for this app yet.',
    'auth/account-exists-with-different-credential': 'This account uses another sign-in method. Please use that method to continue.',
    'auth/user-disabled': 'This Google sign-in is unavailable. Please contact support.',
    'auth/too-many-requests': 'There have been too many sign-in attempts. Please wait and try again.',
  };
  return new Error(messages[code] || 'Google sign-in could not be completed. Please try again.');
}

// Loaded only when Google sign-in is requested. The API owns the lasting session;
// Firebase credentials stay in memory and are cleared after token exchange.
export async function googleIdToken(): Promise<string> {
  if (Object.values(config).some(value => !value?.trim())) {
    throw new Error('Google sign-in is not configured yet.');
  }
  let auth: Auth | undefined;
  try {
    const app = getApps().find(item => item.name === 'osudh24-auth') || initializeApp(config, 'osudh24-auth');
    auth = getAuth(app);
    await setPersistence(auth, inMemoryPersistence);
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({prompt: 'select_account'});
    const result = await signInWithPopup(auth, provider);
    return await result.user.getIdToken(true);
  } catch (cause) {
    throw googleError(cause);
  } finally {
    if (auth) await signOut(auth).catch(() => undefined);
  }
}
