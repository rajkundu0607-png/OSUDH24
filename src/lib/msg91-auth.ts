interface WidgetInstance {
  instanceId?: string;
  destroy?: () => void;
}

interface WidgetConfiguration {
  widgetId: string;
  tokenAuth: string;
  containerId: string;
  exposeMethods: false;
  success: (value: unknown) => void;
  failure: (value: unknown) => void;
}

declare global {
  interface Window {
    initSendOTP?: (configuration: WidgetConfiguration) => WidgetInstance | null | undefined;
    destroyOTPWidget?: (instanceId: string) => void;
  }
}

const scriptUrls = ['https://verify.msg91.com/otp-provider.js', 'https://verify.phone91.com/otp-provider.js'];
let widgetNumber = 0;

// This only validates the callback shape. The server must verify the token with
// MSG91 before it can create or link an account.
export function msg91AccessToken(value: unknown): string | null {
  if (value && typeof value === 'object' && 'type' in value && value.type === 'error') return null;
  const candidates = typeof value === 'string' ? [value] : value && typeof value === 'object'
    ? ['message', 'token', 'access-token'].map(key => (value as Record<string, unknown>)[key]) : [];
  return candidates.find((item): item is string => typeof item === 'string' && item.length <= 12000 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(item)) || null;
}

function abortError() {return new DOMException('Mobile verification was cancelled.', 'AbortError');}

function loadScript(url: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {reject(abortError()); return;}
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    let settled = false;
    const timer = window.setTimeout(() => finish(new Error('Mobile verification could not load. Please try again.')), timeoutMs);
    const onAbort = () => finish(abortError());
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      script.onload = null;
      script.onerror = null;
      if (error) {script.remove(); reject(error);} else resolve();
    }
    script.onload = () => finish(window.initSendOTP ? undefined : new Error('Mobile verification could not load. Please try again.'));
    script.onerror = () => finish(new Error('Mobile verification could not load. Please try again.'));
    signal?.addEventListener('abort', onAbort, {once: true});
    document.head.appendChild(script);
  });
}

async function loadWidget(scriptTimeoutMs: number, signal?: AbortSignal) {
  if (window.initSendOTP) return;
  for (const url of scriptUrls) {
    try {await loadScript(url, scriptTimeoutMs, signal); return;}
    catch (cause) {if (signal?.aborted) throw cause;}
  }
  throw new Error('Mobile verification could not load. Check your connection and try again.');
}

export interface Msg91WidgetOptions {
  widgetId: string;
  tokenAuth: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  scriptTimeoutMs?: number;
}

export async function startMsg91Widget({widgetId, tokenAuth, signal, timeoutMs = 300000, scriptTimeoutMs = 20000}: Msg91WidgetOptions): Promise<string> {
  if (!widgetId.trim() || !tokenAuth.trim()) throw new Error('Mobile sign-in is not configured yet.');
  await loadWidget(scriptTimeoutMs, signal);
  if (signal?.aborted) throw abortError();
  return new Promise((resolve, reject) => {
    const host = document.createElement('div');
    host.id = `osudh24-msg91-${++widgetNumber}`;
    host.style.position = 'relative';
    host.style.zIndex = '2147483000';
    document.body.appendChild(host);
    const bodyOverflow = document.body.style.overflow;
    const rootOverflow = document.documentElement.style.overflow;
    const previousFocus = document.activeElement;
    let instance: WidgetInstance | null | undefined;
    let settled = false;
    let observer: MutationObserver | undefined;
    const onAbort = () => finish(abortError());
    const onClose = () => finish(new Error('Mobile verification was closed. You can try again.'));
    const timer = window.setTimeout(() => finish(new Error('Mobile verification timed out. Please try again.')), timeoutMs);

    function cleanup() {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      observer?.disconnect();
      host.shadowRoot?.removeEventListener('closeWidget', onClose);
      try {
        if (instance?.instanceId && window.destroyOTPWidget) window.destroyOTPWidget(instance.instanceId);
        else instance?.destroy?.();
      } catch { /* Removing the owned host still releases the popup UI. */ }
      host.remove();
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = rootOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    }

    function finish(error?: Error, token?: string) {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(token!);
    }

    signal?.addEventListener('abort', onAbort, {once: true});
    try {
      instance = window.initSendOTP!({
        widgetId, tokenAuth, containerId: host.id, exposeMethods: false,
        success: value => {
          const token = msg91AccessToken(value);
          finish(token ? undefined : new Error('Mobile verification did not return a valid sign-in token. Please try again.'), token || undefined);
        },
        failure: () => {
          // The hosted UI shows recoverable send/code errors itself. Keep it
          // open so an incorrect OTP can be corrected without sending again.
          if (!host.shadowRoot?.querySelector('.msg91-otp-widget')) {
            finish(new Error('Mobile verification could not be completed. Please try again.'));
          }
        },
      });
      // initSendOTP returns its instance synchronously. A synchronous failure
      // callback can settle first, so release the returned instance as well.
      if (settled) {cleanup(); return;}
      if (!instance) {finish(new Error('Mobile verification could not start. Please try again.')); return;}
      host.shadowRoot?.addEventListener('closeWidget', onClose);
      observer = new MutationObserver(() => {
        if (!host.isConnected || host.style.display === 'none') onClose();
      });
      observer.observe(host, {attributes: true, attributeFilter: ['style']});
    } catch {finish(new Error('Mobile verification could not start. Please try again.'));}
  });
}
