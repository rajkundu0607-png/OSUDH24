import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { HttpError } from './errors.mjs';
import { normalizeMobile } from './phone.mjs';

// This module never inspects unsigned token claims or implements a local OTP.
// Tests inject provider functions into createApp; no environment flag enables a bypass.
export function createAuthProviders({ env = process.env, fetchImpl = fetch } = {}) {
  const explicitFirebase = !!(env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY);
  const credentialFile = env.GOOGLE_APPLICATION_CREDENTIALS;
  const googleConfigured = explicitFirebase || !!credentialFile;
  const mobileConfigured = !!(env.MSG91_AUTH_KEY && env.MSG91_TEMPLATE_ID);
  const widgetConfigured = !!(env.MSG91_AUTH_KEY && env.VITE_MSG91_WIDGET_ID && env.VITE_MSG91_TOKEN_AUTH);
  let firebaseAuth;

  async function getFirebaseAuth() {
    if (env.FIREBASE_AUTH_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
      throw new HttpError(503, 'Google sign-in requires live Firebase verification.');
    }
    if (!firebaseAuth) firebaseAuth = (async () => {
      try {
        const [{ initializeApp, cert }, { getAuth }] = await Promise.all([
          import('firebase-admin/app'), import('firebase-admin/auth'),
        ]);
        const account = explicitFirebase ? {
          projectId: env.FIREBASE_PROJECT_ID,
          clientEmail: env.FIREBASE_CLIENT_EMAIL,
          privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        } : JSON.parse(await readFile(credentialFile, 'utf8'));
        const app = initializeApp({
          credential: cert(account),
          ...(env.FIREBASE_PROJECT_ID ? { projectId: env.FIREBASE_PROJECT_ID } : {}),
        }, `osudh24-${randomUUID()}`);
        return getAuth(app);
      } catch {
        firebaseAuth = undefined;
        throw new HttpError(503, 'Google sign-in is not configured correctly. Please contact the store owner.');
      }
    })();
    return firebaseAuth;
  }

  async function msg91(path, { mobile, otp, send = false }) {
    const url = new URL(`https://control.msg91.com/api/v5/${path}`);
    url.searchParams.set('mobile', mobile);
    if (send) {
      url.searchParams.set('template_id', env.MSG91_TEMPLATE_ID);
      url.searchParams.set('otp_length', '6');
      url.searchParams.set('otp_expiry', '5');
    } else url.searchParams.set('otp', otp);
    try {
      const response = await fetchImpl(url, {
        method: send ? 'POST' : 'GET',
        headers: { authkey: env.MSG91_AUTH_KEY, ...(send ? { 'Content-Type': 'application/json' } : {}) },
        ...(send ? { body: '{}' } : {}),
        signal: AbortSignal.timeout(10_000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error('provider unavailable');
      if (result?.type !== 'success') {
        if (!send) return false;
        throw new Error('provider rejected send');
      }
      return true;
    } catch {
      throw new HttpError(502, 'The SMS service could not complete this request. Please try again later.');
    }
  }

  async function verifyWidget(accessToken) {
    try {
      const response = await fetchImpl('https://api.msg91.com/api/v5/widget/verifyAccessToken', {
        method: 'POST',
        headers: { authkey: env.MSG91_AUTH_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'access-token': accessToken }),
        signal: AbortSignal.timeout(10_000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error('provider unavailable');
      if (result?.type !== 'success') throw new HttpError(401, 'Mobile verification is invalid or has already been used. Please verify again.');
      try { return normalizeMobile(result.message); }
      catch { throw new HttpError(401, 'Mobile verification did not confirm a valid Indian mobile number. Please verify again.'); }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, 'The mobile verification service could not complete this request. Please try again later.');
    }
  }

  return {
    google: googleConfigured ? {
      async verifyIdToken(idToken) {
        const auth = await getFirebaseAuth();
        let timer;
        try {
          return await Promise.race([
            auth.verifyIdToken(idToken, true),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new HttpError(503, 'Google sign-in is temporarily unavailable. Please try again.')), 10_000);
              timer.unref?.();
            }),
          ]);
        } catch (error) {
          if (error instanceof HttpError) throw error;
          if (typeof error?.code === 'string' && error.code.startsWith('auth/')) throw new HttpError(401, 'Google could not verify this sign-in. Please sign in again.');
          throw new HttpError(503, 'Google sign-in is temporarily unavailable. Please try again.');
        } finally { clearTimeout(timer); }
      },
    } : null,
    mobile: mobileConfigured ? {
      sendOtp: mobile => msg91('otp', { mobile, send: true }),
      verifyOtp: (mobile, otp) => msg91('otp/verify', { mobile, otp }),
    } : null,
    widget: widgetConfigured ? { verifyAccessToken: verifyWidget } : null,
  };
}
