import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { emptyProfile, type Appointment, type BackendActions, type BackendState, type Order, type Profile, type OtpChallenge } from './types';

const emptyState: BackendState = {
  auth: { user: null, providers: { google: false, mobile: false }, mobileMethod: null, sessionExpiresAt: null },
  products: [], doctors: [], profile: emptyProfile, cart: {}, orders: [], appointments: [],
  prescriptions: [], availability: { dates: [], times: [], booked: [] }, locationPin: '', newsletterEmail: '',
};

interface MutationResult { state: BackendState; order?: Order; appointment?: Appointment }

class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options, credentials: 'same-origin', signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error('Unable to reach the store. Please check the connection and try again.');
  }
  let body;
  try { body = await response.json(); } catch {
    throw new Error('The store returned an unexpected response. Please try again.');
  }
  if (!response.ok) throw new ApiError(typeof body.error === 'string' ? body.error : 'Your changes could not be saved. Please try again.', response.status);
  return body as T;
}

// React StrictMode mounts effects twice in development. Share the initial request
// so both effects use the same guest session instead of creating competing cookies.
let bootstrapRequest: Promise<BackendState> | undefined;
function bootstrap() {
  if (!bootstrapRequest) bootstrapRequest = request<BackendState>('/bootstrap').finally(() => { bootstrapRequest = undefined; });
  return bootstrapRequest;
}

export function useBackend() {
  const [state, setState] = useState(emptyState);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState('');
  const current = useRef(emptyState);
  const ready = useRef(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const orderAttempt = useRef<{ key: string; payload: string } | null>(null);
  const authChannel = useRef<BroadcastChannel | null>(null);
  const generation = useRef(0);

  const accept = useCallback((next: BackendState) => {
    current.current = next;
    ready.current = true;
    setState(next);
    setError('');
    setLoading(false);
  }, []);

  useEffect(() => {
    let active = true;
    const started = generation.current;
    bootstrap().then(next => { if (active && generation.current === started) accept(next); }).catch(cause => {
      if (active && generation.current === started) { setError(cause.message); setLoading(false); }
    });
    return () => { active = false; };
  }, [accept]);

  // Serialize mutations and compute cart changes inside the queue, using the
  // latest confirmed server state even when several clicks happen together.
  const enqueue = useCallback(<T,>(work: (started: number) => Promise<T>): Promise<T> => {
    const started = generation.current;
    setPending(n => n + 1);
    const next = queue.current.then(() => {
      if (started !== generation.current) throw new Error('Your sign-in changed. Please try again.');
      return work(started);
    });
    queue.current = next.catch(() => undefined);
    return next.finally(() => setPending(n => n - 1));
  }, []);

  const invalidateAuth = useCallback(() => {
    generation.current += 1;
    ready.current = false;
    current.current = emptyState;
    setState(emptyState);
    setLoading(true);
    orderAttempt.current = null;
  }, []);

  const recoverUnauthorized = useCallback(async (cause: unknown, started: number, credentialFailure = false) => {
    if (!(cause instanceof ApiError) || cause.status !== 401 || started !== generation.current || !current.current.auth.user) return;
    if (credentialFailure) {
      // A wrong OTP while linking is different from an expired account session.
      // Keep the form/challenge mounted if bootstrap confirms the same account.
      try {
        const next = await request<BackendState>('/bootstrap');
        if (started !== generation.current) return;
        if (next.auth.user?.id !== current.current.auth.user?.id) generation.current += 1;
        accept(next);
      } catch { /* Keep the original credential error visible for a retry. */ }
      return;
    }
    invalidateAuth();
    const recovery = generation.current;
    try {
      const next = await request<BackendState>('/bootstrap');
      if (generation.current === recovery) accept(next);
    } catch { if (generation.current === recovery) setError('Your session has ended. Please reconnect and sign in again.'); }
    finally { if (generation.current === recovery) setLoading(false); }
  }, [accept, invalidateAuth]);

  const mutate = useCallback(async (path: string, method: string, body?: unknown, headers?: Record<string, string>) => {
    if (!ready.current) return Promise.reject(new Error('Please wait for the store to finish loading.'));
    const started = generation.current;
    try {
      const result = await request<MutationResult>(path, {
        method, headers: { 'Content-Type': 'application/json', 'X-Account-Id': current.current.auth.user?.id || 'guest', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (started !== generation.current) throw new Error('Your sign-in changed. Please try again.');
      if (['/auth/google', '/auth/msg91', '/auth/otp/verify', '/auth/logout'].includes(path)) generation.current += 1;
      accept(result.state);
      return result;
    } catch (cause) {
      await recoverUnauthorized(cause, started, path.startsWith('/auth/') && path !== '/auth/logout');
      throw cause;
    }
  }, [accept, recoverUnauthorized]);

  const actions = useMemo<BackendActions>(() => ({
    signInWithGoogle: (idToken, mode = 'login') => enqueue(async () => {
      await mutate('/auth/google', 'POST', { idToken, mode });
      orderAttempt.current = null;
      authChannel.current?.postMessage('auth-changed');
    }),
    signInWithMsg91: (accessToken, mode = 'login') => enqueue(async () => {
      await mutate('/auth/msg91', 'POST', { accessToken, mode });
      orderAttempt.current = null;
      authChannel.current?.postMessage('auth-changed');
    }),
    sendOtp: (mobile, mode = 'login') => enqueue(async started => {
      try {
        const result = await request<OtpChallenge>('/auth/otp/send', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Account-Id': current.current.auth.user?.id || 'guest' }, body: JSON.stringify({ mobile, mode }),
        });
        if (started !== generation.current) throw new Error('Your sign-in changed. Please try again.');
        return result;
      } catch (cause) { await recoverUnauthorized(cause, started, true); throw cause; }
    }),
    verifyOtp: (challengeId, otp) => enqueue(async () => {
      await mutate('/auth/otp/verify', 'POST', { challengeId, otp });
      orderAttempt.current = null;
      authChannel.current?.postMessage('auth-changed');
    }),
    signOut: () => enqueue(async () => {
      await mutate('/auth/logout', 'POST');
      orderAttempt.current = null;
      authChannel.current?.postMessage('auth-changed');
    }),
    changeCart: (id, delta) => enqueue(async () => {
      const quantity = Math.max(0, Math.min(99, (current.current.cart[id] || 0) + delta));
      await mutate(`/cart/items/${id}`, 'PUT', { quantity });
    }),
    removeCartItem: id => enqueue(async () => { await mutate(`/cart/items/${id}`, 'PUT', { quantity: 0 }); }),
    saveProfile: profile => enqueue(async () => { await mutate('/profile', 'PUT', profile); }),
    placeOrder: (profile: Profile, coupon: string) => enqueue(async () => {
      const payload = JSON.stringify({ profile, coupon, cart: current.current.cart });
      if (orderAttempt.current?.payload !== payload) orderAttempt.current = { key: crypto.randomUUID(), payload };
      const result = await mutate('/orders', 'POST', { profile, coupon }, { 'Idempotency-Key': orderAttempt.current.key });
      orderAttempt.current = null;
      if (!result.order) throw new Error('Please check your order history before trying again.');
      return result.order;
    }),
    cancelOrder: id => enqueue(async () => { await mutate(`/orders/${encodeURIComponent(id)}/cancel`, 'POST'); }),
    bookAppointment: input => enqueue(async () => {
      const result = await mutate('/appointments', 'POST', input);
      if (!result.appointment) throw new Error('Please check your appointment history before trying again.');
      return result.appointment;
    }),
    cancelAppointment: id => enqueue(async () => { await mutate(`/appointments/${encodeURIComponent(id)}/cancel`, 'POST'); }),
    deleteProfile: () => enqueue(async () => { await mutate('/profile', 'DELETE'); }),
    uploadPrescription: file => enqueue(async started => {
      try {
        const result = await request<MutationResult>('/prescriptions', {
          method: 'POST', headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name), 'X-Account-Id': current.current.auth.user?.id || 'guest' }, body: file,
        });
        if (started !== generation.current) throw new Error('Your sign-in changed. Please try again.');
        accept(result.state);
      } catch (cause) { await recoverUnauthorized(cause, started); throw cause; }
    }),
    deletePrescription: id => enqueue(async () => { await mutate(`/prescriptions/${encodeURIComponent(id)}`, 'DELETE'); }),
    saveLocation: pin => enqueue(async () => { await mutate('/location', 'PUT', { pin }); }),
    subscribe: email => enqueue(async () => { await mutate('/newsletter', 'POST', { email }); }),
    refresh: () => enqueue(async started => {
      try {
        const next = await request<BackendState>('/bootstrap');
        if (started !== generation.current) return;
        if (next.auth.user?.id !== current.current.auth.user?.id) generation.current += 1;
        accept(next);
      } catch (cause) { if (started === generation.current) setError((cause as Error).message); throw cause; }
      finally { if (started === generation.current) setLoading(false); }
    }),
  }), [accept, enqueue, mutate, recoverUnauthorized]);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel('osudh24-auth');
    authChannel.current = channel;
    channel.onmessage = event => {
      if (event.data !== 'auth-changed') return;
      // Cookies are shared between tabs. Remove stale account data immediately,
      // then reload the principal before allowing any more mutations.
      invalidateAuth();
      void actions.refresh().catch(() => undefined);
    };
    return () => { authChannel.current = null; channel.close(); };
  }, [actions.refresh, invalidateAuth]);

  return { state, actions, loading, busy: loading || pending > 0, error };
}
