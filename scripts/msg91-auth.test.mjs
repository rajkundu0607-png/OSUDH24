import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/msg91-auth.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl';

// The widget helper runs against a small owned DOM and deterministic timers.
// No third-party script is downloaded and no OTP request leaves this process.
function harness() {
  const timers = new Map();
  const elements = [];
  const observers = [];
  let now = 0;
  let timerNumber = 0;

  class Element extends EventTarget {
    constructor(tagName) {
      super();
      this.tagName = tagName.toUpperCase();
      this.id = '';
      this.className = '';
      this.style = { overflow: '', display: '' };
      this.children = [];
      this.parentNode = null;
      this.shadowRoot = null;
      this.onload = null;
      this.onerror = null;
      this.focusCount = 0;
      elements.push(this);
    }
    get isConnected() { return this === document.documentElement || Boolean(this.parentNode?.isConnected); }
    appendChild(child) {
      child.remove();
      this.children.push(child);
      child.parentNode = this;
      return child;
    }
    remove() {
      if (!this.parentNode) return;
      this.parentNode.children = this.parentNode.children.filter(item => item !== this);
      this.parentNode = null;
    }
    focus() { this.focusCount++; document.activeElement = this; }
    querySelector(selector) {
      return this.children.find(child => selector.startsWith('.')
        ? child.className.split(/\s+/).includes(selector.slice(1))
        : selector.startsWith('#') ? child.id === selector.slice(1) : child.tagName.toLowerCase() === selector) || null;
    }
    attachShadow() {
      this.shadowRoot = new Element('shadow-root');
      this.shadowRoot.parentNode = this;
      return this.shadowRoot;
    }
  }

  const document = {
    createElement: tag => new Element(tag),
    getElementById: id => elements.find(element => element.id === id && element.isConnected) || null,
    activeElement: null,
  };
  document.documentElement = new Element('html');
  document.head = document.documentElement.appendChild(new Element('head'));
  document.body = document.documentElement.appendChild(new Element('body'));

  class Observer {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
  }

  const window = {
    setTimeout(callback, delay) {
      const id = ++timerNumber;
      timers.set(id, { callback, due: now + Number(delay) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, module: { exports }, window, document, HTMLElement: Element,
    MutationObserver: Observer, DOMException, AbortController, AbortSignal,
  }, { filename: 'src/lib/msg91-auth.ts' });

  return {
    api: exports, window, document, timers, observers,
    get scripts() { return elements.filter(element => element.tagName === 'SCRIPT'); },
    get hosts() { return document.body.children.filter(element => element.id.startsWith('osudh24-msg91-')); },
    start(options = {}) { return exports.startMsg91Widget({ widgetId: 'test-widget-id', tokenAuth: 'test-public-token-auth', ...options }); },
    advance(milliseconds) {
      const destination = now + milliseconds;
      let safety = 0;
      while (true) {
        const next = [...timers.entries()].filter(([, item]) => item.due <= destination).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        assert.ok(++safety < 1000, 'timer callback loop');
        now = next[1].due;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = destination;
    },
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('callback parser accepts only supported JWT token shapes and rejects error acknowledgments', () => {
  const { api } = harness();
  for (const value of [TOKEN, { message: TOKEN }, { token: TOKEN }, { 'access-token': TOKEN }, { type: 'success', message: TOKEN }]) {
    assert.equal(api.msg91AccessToken(value), TOKEN);
  }
  for (const value of [
    null, undefined, 42, [], {}, '', 'SMS sent successfully', '919876543210', 'request_123456',
    { type: 'success', message: 'OTP sent successfully' }, { type: 'error', token: TOKEN },
    { type: 'error', message: TOKEN }, { message: {} }, `${'a'.repeat(11997)}.b.c`,
  ]) assert.equal(api.msg91AccessToken(value), null, JSON.stringify(value));
  const longestAccepted = `${'a'.repeat(11996)}.b.c`;
  assert.equal(longestAccepted.length, 12000);
  assert.equal(api.msg91AccessToken(longestAccepted), longestAccepted);
});

test('widget scripts load only after an explicit start and use the secondary URL after a failed primary', async () => {
  const h = harness();
  assert.equal(h.scripts.length, 0);
  const pending = h.start();
  assert.equal(h.scripts.length, 1);
  const primary = h.scripts[0];
  assert.equal(primary.src, 'https://verify.msg91.com/otp-provider.js');
  assert.equal(primary.async, true);
  primary.onerror();
  await flush();
  assert.equal(primary.isConnected, false);
  assert.equal(h.scripts.length, 2);
  const fallback = h.scripts[1];
  assert.equal(fallback.src, 'https://verify.phone91.com/otp-provider.js');
  let config;
  h.window.initSendOTP = value => { config = value; return { destroy() {} }; };
  fallback.onload();
  await flush();
  assert.equal(config.widgetId, 'test-widget-id');
  config.success({ message: TOKEN });
  assert.equal(await pending, TOKEN);
  assert.equal(h.hosts.length, 0);
  assert.equal(h.timers.size, 0);
});

test('script loading is bounded and both loader failures leave no widget or pending timers', async () => {
  const h = harness();
  const pending = assert.rejects(h.start({ scriptTimeoutMs: 20 }), /could not load/i);
  h.advance(20);
  await flush();
  assert.equal(h.scripts.length, 2);
  assert.equal(h.scripts[0].isConnected, false);
  h.advance(20);
  await pending;
  assert.equal(h.scripts[1].isConnected, false);
  assert.equal(h.hosts.length, 0);
  assert.equal(h.timers.size, 0);
});

test('a script load without the expected widget global falls back and rejects when neither initializes', async () => {
  const h = harness();
  const pending = assert.rejects(h.start(), /could not load/i);
  h.scripts[0].onload();
  await flush();
  assert.equal(h.scripts.length, 2);
  h.scripts[1].onload();
  await pending;
  assert.equal(h.scripts.every(script => !script.isConnected), true);
  assert.equal(h.timers.size, 0);
});

test('preloaded widget success settles exactly once, destroys its own instance, and restores page state', async () => {
  const h = harness();
  const previousFocus = h.document.body.appendChild(h.document.createElement('button'));
  const unrelated = h.document.body.appendChild(h.document.createElement('div'));
  unrelated.id = 'unrelated-popup';
  previousFocus.focus();
  h.document.body.style.overflow = 'scroll';
  h.document.documentElement.style.overflow = 'auto';
  const destroyed = [];
  let instanceDestroy = 0;
  let config;
  h.window.destroyOTPWidget = id => destroyed.push(id);
  h.window.initSendOTP = value => {
    config = value;
    h.document.body.style.overflow = 'hidden';
    h.document.documentElement.style.overflow = 'hidden';
    return { instanceId: 'owned-instance', destroy() { instanceDestroy++; } };
  };
  const pending = h.start();
  await flush();
  assert.equal(h.scripts.length, 0);
  assert.equal(h.hosts.length, 1);
  assert.equal(config.containerId, h.hosts[0].id);
  assert.match(config.containerId, /^osudh24-msg91-\d+$/);
  assert.equal(config.exposeMethods, false);
  assert.equal('identifier' in config, false);
  config.success({ token: TOKEN });
  config.success('another.token.signature');
  config.failure({ message: 'late callback must be ignored' });
  assert.equal(await pending, TOKEN);
  assert.deepEqual(destroyed, ['owned-instance']);
  assert.equal(instanceDestroy, 0);
  assert.equal(h.hosts.length, 0);
  assert.equal(unrelated.isConnected, true);
  assert.equal(h.document.body.style.overflow, 'scroll');
  assert.equal(h.document.documentElement.style.overflow, 'auto');
  assert.equal(previousFocus.focusCount, 2);
  assert.equal(h.observers.every(observer => observer.disconnected), true);
  assert.equal(h.timers.size, 0);
});

test('an already-aborted start never loads a script or initializes the widget', async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  let initialized = 0;
  await assert.rejects(h.start({ signal: controller.signal }), error => error.name === 'AbortError');
  h.window.initSendOTP = () => { initialized++; return {}; };
  await assert.rejects(h.start({ signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(initialized, 0);
  assert.equal(h.scripts.length, 0);
  assert.equal(h.hosts.length, 0);
  assert.equal(h.timers.size, 0);
});

test('cancelling during script load removes the owned script and ignores a late onload', async () => {
  const h = harness();
  const controller = new AbortController();
  let initialized = 0;
  const pending = assert.rejects(h.start({ signal: controller.signal }), error => error.name === 'AbortError');
  const script = h.scripts[0];
  const lateOnload = script.onload;
  controller.abort();
  h.window.initSendOTP = () => { initialized++; return {}; };
  lateOnload();
  await pending;
  assert.equal(initialized, 0);
  assert.equal(script.isConnected, false);
  assert.equal(script.onload, null);
  assert.equal(script.onerror, null);
  assert.equal(h.scripts.length, 1);
  assert.equal(h.hosts.length, 0);
  assert.equal(h.timers.size, 0);
});

test('cancelling an active widget destroys it and ignores every late provider callback', async () => {
  const h = harness();
  const controller = new AbortController();
  let destroyed = 0;
  let config;
  h.window.initSendOTP = value => { config = value; return { destroy() { destroyed++; } }; };
  const pending = assert.rejects(h.start({ signal: controller.signal }), error => error.name === 'AbortError');
  await flush();
  controller.abort();
  config.success(TOKEN);
  config.failure({ message: 'late failure' });
  await pending;
  assert.equal(destroyed, 1);
  assert.equal(h.hosts.length, 0);
  assert.equal(h.timers.size, 0);
});

test('widget timeout destroys its instance and restores document overflow', async () => {
  const h = harness();
  let destroyed = 0;
  h.document.body.style.overflow = 'visible';
  h.window.initSendOTP = () => {
    h.document.body.style.overflow = 'hidden';
    return { destroy() { destroyed++; } };
  };
  const pending = assert.rejects(h.start({ timeoutMs: 25 }), /timed out/i);
  await flush();
  h.advance(25);
  await pending;
  assert.equal(destroyed, 1);
  assert.equal(h.hosts.length, 0);
  assert.equal(h.document.body.style.overflow, 'visible');
  assert.equal(h.timers.size, 0);
});

test('invalid success callbacks and provider failures reject with a safe error and release the UI', async () => {
  for (const failure of [false, true]) {
    const h = harness();
    let config;
    let destroyed = 0;
    h.window.initSendOTP = value => { config = value; return { destroy() { destroyed++; } }; };
    const pending = assert.rejects(h.start(), error => {
      assert.ok(!String(error).includes('provider-secret'));
      return /verification/i.test(String(error));
    });
    await flush();
    if (failure) config.failure({ message: 'provider-secret' });
    else config.success({ type: 'success', message: 'OTP sent successfully' });
    await pending;
    assert.equal(destroyed, 1);
    assert.equal(h.hosts.length, 0);
    assert.equal(h.timers.size, 0);
  }
});

test('recoverable hosted-widget errors stay open and can complete with a later valid token', async () => {
  const h = harness();
  let config;
  let destroyed = 0;
  let settled = false;
  h.document.body.style.overflow = 'scroll';
  h.window.initSendOTP = value => {
    config = value;
    const shadow = h.document.getElementById(value.containerId).attachShadow();
    const hostedWidget = h.document.createElement('div');
    hostedWidget.className = 'msg91-otp-widget';
    shadow.appendChild(hostedWidget);
    h.document.body.style.overflow = 'hidden';
    return { destroy() { destroyed++; } };
  };
  const pending = h.start().finally(() => { settled = true; });
  await flush();
  config.failure({ type: 'error', message: 'Incorrect OTP, try again.' });
  await flush();
  assert.equal(settled, false);
  assert.equal(destroyed, 0);
  assert.equal(h.hosts.length, 1);
  assert.equal(h.document.body.style.overflow, 'hidden');
  assert.equal(h.timers.size, 1);
  config.success({ 'access-token': TOKEN });
  assert.equal(await pending, TOKEN);
  assert.equal(settled, true);
  assert.equal(destroyed, 1);
  assert.equal(h.hosts.length, 0);
  assert.equal(h.document.body.style.overflow, 'scroll');
  assert.equal(h.timers.size, 0);
});

test('synchronous callbacks clean up the instance returned after the callback has settled', async () => {
  const h = harness();
  let destroyed = 0;
  h.window.initSendOTP = config => {
    config.success(TOKEN);
    return { destroy() { destroyed++; } };
  };
  assert.equal(await h.start(), TOKEN);
  assert.equal(destroyed, 1);
  assert.equal(h.hosts.length, 0);
  assert.equal(h.timers.size, 0);
});

test('widget close events reject the pending attempt and remove its owned shadow host', async () => {
  const h = harness();
  let destroyed = 0;
  h.window.initSendOTP = config => {
    h.document.getElementById(config.containerId).attachShadow();
    return { destroy() { destroyed++; } };
  };
  const pending = assert.rejects(h.start(), /closed/i);
  await flush();
  h.hosts[0].shadowRoot.dispatchEvent(new Event('closeWidget'));
  await pending;
  assert.equal(destroyed, 1);
  assert.equal(h.hosts.length, 0);
  assert.equal(h.observers.every(observer => observer.disconnected), true);
  assert.equal(h.timers.size, 0);
});
