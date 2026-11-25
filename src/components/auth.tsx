import {useEffect, useRef, useState, type FormEvent} from 'react';
import {ArrowRight, Check, KeyRound, Phone, ShieldCheck} from 'lucide-react';
import type {BackendActions, BackendState} from '@/lib/types';

interface Props {
  state: BackendState;
  actions: BackendActions;
  busy: boolean;
  onSuccess: () => void;
  onContinue?: () => void;
  mode?: 'login' | 'link';
}

interface OtpChallenge {
  challengeId: string;
  expiresAt: string;
  resendAt: number;
}

const firebaseConfigured = [
  import.meta.env.VITE_FIREBASE_API_KEY,
  import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  import.meta.env.VITE_FIREBASE_PROJECT_ID,
  import.meta.env.VITE_FIREBASE_APP_ID,
].every(value => Boolean(value?.trim()));
const msg91WidgetId = import.meta.env.VITE_MSG91_WIDGET_ID?.trim() || '';
const msg91TokenAuth = import.meta.env.VITE_MSG91_TOKEN_AUTH?.trim() || '';

function remainingSeconds(until: number, now: number) {
  return Math.max(0, Math.ceil((until - now) / 1000));
}

function clockLabel(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function AuthPanel({state, actions, busy, onSuccess, onContinue, mode = 'login'}: Props) {
  const [mobile, setMobile] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<OtpChallenge | null>(null);
  const [now, setNow] = useState(Date.now);
  const [pending, setPending] = useState<'google' | 'send' | 'verify' | 'widget' | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const inProgress = useRef(false);
  const active = useRef(true);
  const widgetAbort = useRef<AbortController | null>(null);
  const linking = mode === 'link';
  const linked = state.auth.user?.providers || [];
  const googleLinked = linking && linked.includes('google');
  const mobileLinked = linking && linked.includes('mobile');
  const googleReady = state.auth.providers.google && firebaseConfigured;
  const widgetMode = state.auth.mobileMethod === 'widget';
  const mobileReady = state.auth.providers.mobile && (widgetMode ? Boolean(msg91WidgetId && msg91TokenAuth) : state.auth.mobileMethod === 'otp');
  const disabled = busy || pending !== null;
  const resendIn = challenge ? remainingSeconds(challenge.resendAt, now) : 0;
  const expiresIn = challenge ? remainingSeconds(Date.parse(challenge.expiresAt), now) : 0;

  useEffect(() => {
    active.current = true;
    return () => {active.current = false; widgetAbort.current?.abort();};
  }, []);

  useEffect(() => {
    if (!challenge) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [challenge]);

  async function run(kind: 'google' | 'send' | 'verify' | 'widget', action: () => Promise<void>) {
    if (inProgress.current || busy) return;
    inProgress.current = true;
    setPending(kind);
    setError('');
    setMessage('');
    try {
      await action();
    } catch (cause) {
      if (active.current && !(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause instanceof Error ? cause.message : 'Sign-in could not be completed. Please try again.');
    } finally {
      inProgress.current = false;
      if (active.current) setPending(null);
    }
  }

  function mobileWidgetSignIn() {
    if (!mobileReady || !widgetMode || mobileLinked) return;
    void run('widget', async () => {
      const controller = new AbortController();
      widgetAbort.current = controller;
      try {
        const {startMsg91Widget} = await import('@/lib/msg91-auth');
        if (!active.current || controller.signal.aborted) return;
        const accessToken = await startMsg91Widget({widgetId: msg91WidgetId, tokenAuth: msg91TokenAuth, signal: controller.signal});
        if (!active.current || controller.signal.aborted) return;
        await actions.signInWithMsg91(accessToken, mode);
        if (active.current) onSuccess();
      } finally {
        if (widgetAbort.current === controller) widgetAbort.current = null;
      }
    });
  }

  function googleSignIn() {
    if (!googleReady || googleLinked) return;
    void run('google', async () => {
      let googleIdToken: () => Promise<string>;
      try {({googleIdToken} = await import('@/lib/firebase-auth'));}
      catch {throw new Error('Google sign-in could not be loaded. Check your connection and try again.');}
      if (!active.current) return;
      const token = await googleIdToken();
      if (!active.current) return;
      await actions.signInWithGoogle(token, mode);
      if (active.current) onSuccess();
    });
  }

  function sendCode(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!mobileReady || mobileLinked || resendIn > 0) return;
    if (!/^[6-9][0-9]{9}$/.test(mobile)) {
      setError('Enter a valid 10-digit Indian mobile number.');
      return;
    }
    void run('send', async () => {
      const result = await actions.sendOtp(`+91${mobile}`, mode);
      if (!active.current) return;
      const receivedAt = Date.now();
      if (!Number.isFinite(Date.parse(result.expiresAt))) throw new Error('A verification code could not be started. Please try again.');
      setNow(receivedAt);
      setChallenge({challengeId: result.challengeId, expiresAt: result.expiresAt, resendAt: receivedAt + result.retryAfter * 1000});
      setCode('');
      setMessage('A verification code has been sent to your mobile number.');
    });
  }

  function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!challenge || expiresIn === 0) {
      setError('This code has expired. Request a new code to continue.');
      return;
    }
    if (!/^[0-9]{6}$/.test(code)) {
      setError('Enter the six-digit code sent to your mobile number.');
      return;
    }
    void run('verify', async () => {
      await actions.verifyOtp(challenge.challengeId, code);
      if (active.current) onSuccess();
    });
  }

  return (
    <div className="commerce auth-panel" aria-busy={disabled}>
      <ShieldCheck className="modal-icon" />
      <h2>{linking ? 'Add a sign-in method' : 'Welcome to Osudh24'}</h2>
      <p>{linking ? 'Connect another way to sign in to your existing account.' : 'Sign in to keep your profile, prescriptions and saved history together.'}</p>
      {error && <p className="form-message" role="alert">{error}</p>}
      {message && <p className="form-message" role="status">{message}</p>}

      <button type="button" className="auth-google" disabled={disabled || !googleReady || googleLinked} onClick={googleSignIn}>
        <span className="auth-google-mark" aria-hidden="true">G</span>
        {pending === 'google' ? 'Opening Google…' : googleLinked ? 'Google connected' : linking ? 'Connect Google' : 'Continue with Google'}
        {googleLinked && <Check size={17} />}
      </button>
      {!googleReady && !googleLinked && <p className="auth-hint">Google sign-in is not configured yet.</p>}

      <div className="auth-divider"><span>{linking ? 'Mobile number' : 'or use your mobile number'}</span></div>
      {mobileLinked ? (
        <p className="auth-hint"><Check size={15} /> Your verified mobile number is already connected.</p>
      ) : !mobileReady ? (
        <p className="auth-hint">Mobile sign-in is not configured yet.</p>
      ) : widgetMode ? (
        <>
          <p className="auth-hint">Enter and verify your mobile number in the secure verification window.</p>
          <button type="button" className="primary" disabled={disabled} onClick={mobileWidgetSignIn}>
            <Phone size={16} /> {pending === 'widget' ? 'Verifying mobile…' : linking ? 'Connect mobile number' : 'Continue with mobile'} <ArrowRight size={16} />
          </button>
          {pending === 'widget' && <button type="button" className="secondary-action" onClick={() => widgetAbort.current?.abort()}>Cancel verification</button>}
        </>
      ) : challenge ? (
        <>
          <p className="auth-hint">Enter the code sent to +91 {mobile.slice(0, 5)} {mobile.slice(5)}.</p>
          <form onSubmit={verifyCode}>
            <fieldset className="form-fields" disabled={disabled}>
              <label>
                Verification code
                <input
                  className="auth-code" autoFocus required type="text" inputMode="numeric" autoComplete="one-time-code"
                  pattern="[0-9]{6}" minLength={6} maxLength={6} placeholder="6-digit code" value={code}
                  aria-describedby="otp-expiry" onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                />
              </label>
              <p id="otp-expiry" className="auth-hint">{expiresIn > 0 ? `Code expires in ${clockLabel(expiresIn)}.` : 'This code has expired. Request a new code.'}</p>
              <button className="primary" disabled={expiresIn === 0 || code.length !== 6}>
                <KeyRound size={16} /> {pending === 'verify' ? 'Verifying…' : linking ? 'Verify and connect mobile' : 'Verify and sign in'} <ArrowRight size={16} />
              </button>
            </fieldset>
          </form>
          <div className="auth-actions">
            <button type="button" className="secondary-action" disabled={disabled || resendIn > 0} onClick={() => sendCode()}>
              {pending === 'send' ? 'Sending…' : resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}
            </button>
            <button type="button" className="secondary-action" disabled={disabled} onClick={() => {setChallenge(null); setCode(''); setError(''); setMessage('');}}>
              Change mobile number
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={sendCode}>
          <fieldset className="form-fields" disabled={disabled}>
            <label>
              Mobile number
              <span className="auth-phone">
                <span className="auth-country" aria-hidden="true">+91</span>
                <input
                  required type="tel" inputMode="numeric" autoComplete="tel-national" pattern="[6-9][0-9]{9}"
                  maxLength={10} minLength={10} placeholder="10-digit mobile number" value={mobile}
                  aria-label="Indian mobile number" aria-describedby="mobile-signin-note"
                  onChange={event => setMobile(event.target.value.replace(/\D/g, '').slice(0, 10))}
                />
              </span>
            </label>
            <p className="auth-hint" id="mobile-signin-note">We’ll send a six-digit verification code by SMS.</p>
            <button className="primary" disabled={mobile.length !== 10}><Phone size={16} />{pending === 'send' ? 'Sending code…' : 'Send verification code'} <ArrowRight size={16} /></button>
          </fieldset>
        </form>
      )}
      {onContinue && pending !== 'widget' && <button type="button" className="secondary-action" disabled={disabled} onClick={onContinue}>{linking ? 'Back to profile' : 'Continue browsing'}</button>}
    </div>
  );
}
