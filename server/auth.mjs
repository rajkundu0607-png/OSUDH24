import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { transactionAsync } from './storage.mjs';
import { HttpError } from './errors.mjs';
import { normalizeMobile } from './phone.mjs';
export { normalizeMobile } from './phone.mjs';

const COOKIE = 'osudh24_session';
const SESSION_AGE = 30 * 24 * 60 * 60;
const HOUR = 60 * 60 * 1000;
const hash = value => createHash('sha256').update(value).digest('hex');

function modeFor(value) {
  const mode = value === undefined ? 'login' : value;
  if (!['login', 'link'].includes(mode)) throw new HttpError(422, 'Choose a valid sign-in action.');
  return mode;
}

export function createAuthManager({ db, providers, now = Date.now, secureCookies = false, clientAddress = req => req.socket.remoteAddress }) {
  const browserRow = async id => await db.prepare('SELECT id,owner_id AS ownerId,user_id AS userId,expires_at AS expiresAt FROM browser_sessions WHERE id = ?').get(id);

  function setCookie(res, token) {
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_AGE}${secureCookies ? '; Secure' : ''}`);
  }

  async function newBrowser(ownerId, userId = null) {
    const token = randomBytes(32).toString('hex');
    const browser = { id: randomUUID(), ownerId, userId, expiresAt: now() + SESSION_AGE * 1000 };
    await db.prepare('INSERT INTO browser_sessions(id,owner_id,user_id,token_hash,expires_at) VALUES (?,?,?,?,?)')
      .run(browser.id, ownerId, userId, hash(token), browser.expiresAt);
    return { browser, token };
  }

  async function newOwner() {
    // These legacy columns are retained for a nondestructive migration. Cookies
    // are read exclusively from browser_sessions after schema version 2.
    const result = await db.prepare('INSERT INTO sessions(token_hash,expires_at) VALUES (?,?)')
      .run(hash(randomBytes(32)), Math.floor(now() / 1000) + SESSION_AGE);
    return Number(result.lastInsertRowid);
  }

  async function activeBrowser(browser) {
    const active = await browserRow(browser.id);
    if (!active || active.expiresAt <= now()) throw new HttpError(401, 'Your session has expired. Please sign in again.');
    return active;
  }

  async function requireAuthenticated(browser) {
    const active = await activeBrowser(browser);
    if (!active.userId) throw new HttpError(401, 'Please sign in to continue.');
    return active;
  }

  async function checkMode(browser, mode) {
    const active = await activeBrowser(browser);
    if (mode === 'link' && !active.userId) throw new HttpError(401, 'Sign in before linking another sign-in method.');
    if (mode === 'login' && active.userId) throw new HttpError(409, 'You are already signed in. Sign out before switching accounts, or choose Link.');
    return active;
  }

  function finishRotation(browser, result, res) {
    Object.assign(browser, result.browser);
    setCookie(res, result.token);
  }

  async function sessionFor(req, res) {
    await db.prepare('DELETE FROM browser_sessions WHERE expires_at <= ?').run(now());
    const token = req.headers.cookie?.split(';').map(part => part.trim())
      .find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      const row = await db.prepare('SELECT id,owner_id AS ownerId,user_id AS userId,expires_at AS expiresAt FROM browser_sessions WHERE token_hash = ? AND expires_at > ?').get(hash(token), now());
      if (row) return row;
    }
    const result = await transactionAsync(db, async () => await newBrowser(await newOwner()));
    setCookie(res, result.token);
    return result.browser;
  }

  async function authState(browser) {
    const user = browser.userId ? await db.prepare('SELECT id,name,email,phone FROM users WHERE id = ?').get(browser.userId) : null;
    if (user) user.providers = (await db.prepare('SELECT provider FROM auth_identities WHERE user_id = ? ORDER BY provider').all(user.id)).map(item => item.provider);
    return {
      user: user || null,
      providers: { google: !!providers.google, mobile: !!(providers.widget || providers.mobile) },
      mobileMethod: providers.widget ? 'widget' : providers.mobile ? 'otp' : null,
      sessionExpiresAt: user ? new Date(browser.expiresAt).toISOString() : null,
    };
  }

  async function mergeGuest(sourceOwner, targetOwner) {
    if (sourceOwner === targetOwner) return;
    if (await db.prepare('SELECT id FROM users WHERE owner_id = ?').get(sourceOwner)) throw new HttpError(409, 'Sign out before switching accounts.');
    const items = await db.prepare('SELECT product_id,quantity FROM cart WHERE session_id = ?').all(sourceOwner);
    const merge = db.prepare('INSERT INTO cart(session_id,product_id,quantity) VALUES (?,?,?) ON CONFLICT(session_id,product_id) DO UPDATE SET quantity = MIN(99, cart.quantity + excluded.quantity)');
    for (const item of items) await merge.run(targetOwner, item.product_id, item.quantity);
    await db.prepare('DELETE FROM cart WHERE session_id = ?').run(sourceOwner);
    // Preserve pre-auth demo records from the old application. Names/contacts in
    // the editable profile never choose or link an authenticated account.
    const orders = await db.prepare('SELECT id,idempotency_key FROM orders WHERE session_id = ?').all(sourceOwner);
    for (const order of orders) {
      const collision = await db.prepare('SELECT id FROM orders WHERE session_id = ? AND idempotency_key = ?').get(targetOwner, order.idempotency_key);
      await db.prepare('UPDATE orders SET session_id = ?,idempotency_key = ? WHERE id = ?')
        .run(targetOwner, collision ? `migrated-${randomUUID()}` : order.idempotency_key, order.id);
    }
    for (const table of ['appointments', 'prescriptions']) await db.prepare(`UPDATE ${table} SET session_id = ? WHERE session_id = ?`).run(targetOwner, sourceOwner);
    const source = await db.prepare('SELECT profile,location_pin,newsletter_email FROM sessions WHERE id = ?').get(sourceOwner);
    const target = await db.prepare('SELECT profile,location_pin,newsletter_email FROM sessions WHERE id = ?').get(targetOwner);
    const from = JSON.parse(source.profile);
    const to = JSON.parse(target.profile);
    const merged = { ...from, ...Object.fromEntries(Object.entries(to).filter(([, value]) => value !== '')) };
    await db.prepare('UPDATE sessions SET profile = ?,location_pin = ?,newsletter_email = ? WHERE id = ?')
      .run(JSON.stringify(merged), target.location_pin || source.location_pin, target.newsletter_email || source.newsletter_email, targetOwner);
    // Other tabs carrying the pre-login guest cookie must not retain a path to
    // personal data that has just been adopted by this account.
    await db.prepare('DELETE FROM browser_sessions WHERE owner_id = ? AND user_id IS NULL').run(sourceOwner);
  }

  async function completeIdentity(browser, identity, mode, res, challengeId, widgetTokenHash) {
    const result = await transactionAsync(db, async () => {
      const active = await checkMode(browser, mode);
      if (challengeId) {
        const challenge = await db.prepare('SELECT * FROM otp_challenges WHERE id = ? AND browser_id = ?').get(challengeId, active.id);
        if (!challenge || challenge.status !== 'verifying' || challenge.expires_at <= now()) throw new HttpError(401, 'This verification has expired. Request a new code.');
        await db.prepare("UPDATE otp_challenges SET status = 'consumed' WHERE id = ?").run(challengeId);
      }
      if (widgetTokenHash) {
        const use = await db.prepare('SELECT status,expires_at FROM widget_token_uses WHERE token_hash = ? AND browser_id = ?').get(widgetTokenHash, active.id);
        if (!use || use.status !== 'verifying' || use.expires_at <= now()) throw new HttpError(401, 'This mobile verification has expired. Please verify again.');
        await db.prepare("UPDATE widget_token_uses SET status = 'consumed' WHERE token_hash = ?").run(widgetTokenHash);
      }
      const existing = await db.prepare('SELECT user_id FROM auth_identities WHERE provider = ? AND subject = ?').get(identity.provider, identity.subject);
      let userId;
      let ownerId;
      if (mode === 'link') {
        if (existing && existing.user_id !== active.userId) throw new HttpError(409, 'That sign-in method already belongs to another account. Sign in to that account instead.');
        const providerIdentity = await db.prepare('SELECT subject FROM auth_identities WHERE provider = ? AND user_id = ?').get(identity.provider, active.userId);
        if (providerIdentity && providerIdentity.subject !== identity.subject) throw new HttpError(409, 'A different account is already linked to this sign-in method.');
        userId = active.userId;
        ownerId = active.ownerId;
      } else if (existing) {
        userId = existing.user_id;
        ownerId = (await db.prepare('SELECT owner_id FROM users WHERE id = ?').get(userId)).owner_id;
        await mergeGuest(active.ownerId, ownerId);
      } else {
        userId = randomUUID();
        ownerId = active.ownerId;
        await db.prepare('INSERT INTO users(id,owner_id,name,email,phone,created_at) VALUES (?,?,?,?,?,?)')
          .run(userId, ownerId, identity.name || '', identity.email || null, identity.phone || null, now());
      }
      if (!existing) await db.prepare('INSERT INTO auth_identities(provider,subject,user_id) VALUES (?,?,?)').run(identity.provider, identity.subject, userId);
      if (identity.provider === 'google') {
        await db.prepare('UPDATE users SET email = ?,name = CASE WHEN name = ? THEN ? ELSE name END WHERE id = ?').run(identity.email, '', identity.name || '', userId);
      } else await db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(identity.phone, userId);
      // Revoke every remaining guest cookie for this data owner on first login.
      await db.prepare('DELETE FROM browser_sessions WHERE owner_id = ? AND user_id IS NULL').run(ownerId);
      await db.prepare('DELETE FROM browser_sessions WHERE id = ?').run(active.id);
      return await newBrowser(ownerId, userId);
    });
    finishRotation(browser, result, res);
  }

  async function reserveSend(browser, mobile, ip) {
    const scopes = [
      { scope: 'phone', key: hash(mobile), max: 5 },
      { scope: 'browser', key: hash(browser.id), max: 5 },
      { scope: 'ip', key: hash(ip || 'unknown'), max: 20 },
    ];
    await transactionAsync(db, async () => {
      const timestamp = now();
      for (const item of scopes) {
        const row = await db.prepare('SELECT * FROM auth_rate_limits WHERE scope = ? AND key = ?').get(item.scope, item.key);
        if (!row) continue;
        if (item.scope === 'phone' && timestamp - row.last_sent < 60_000) throw new HttpError(429, 'Please wait before requesting another code.', Math.max(1, Math.ceil((60_000 - (timestamp - row.last_sent)) / 1000)));
        if (timestamp - row.window_start < HOUR && row.count >= item.max) throw new HttpError(429, 'Too many verification requests. Please try again later.', Math.max(1, Math.ceil((HOUR - (timestamp - row.window_start)) / 1000)));
      }
      const update = db.prepare(`INSERT INTO auth_rate_limits(scope,key,window_start,count,last_sent) VALUES (?,?,?,1,?)
        ON CONFLICT(scope,key) DO UPDATE SET
        count = CASE WHEN ? - auth_rate_limits.window_start >= ? THEN 1 ELSE auth_rate_limits.count + 1 END,
        window_start = CASE WHEN ? - auth_rate_limits.window_start >= ? THEN ? ELSE auth_rate_limits.window_start END,
        last_sent = excluded.last_sent`);
      for (const item of scopes) await update.run(item.scope, item.key, timestamp, timestamp, timestamp, HOUR, timestamp, HOUR, timestamp);
    });
  }

  async function reserveWidgetToken(browser, tokenHash, ip) {
    await transactionAsync(db, async () => {
      const timestamp = now();
      // MSG91 also enforces token expiration and one-time verification. Keeping
      // a persistent digest prevents concurrent calls and local replay without
      // storing the access token or trusting its unsigned expiry claim.
      await db.prepare('DELETE FROM widget_token_uses WHERE expires_at <= ?').run(timestamp);
      if (await db.prepare('SELECT token_hash FROM widget_token_uses WHERE token_hash = ?').get(tokenHash)) {
        throw new HttpError(401, 'This mobile verification has already been used. Please verify again.');
      }
      const scopes = [
        { scope: 'widget-browser', key: hash(browser.id), max: 10 },
        { scope: 'widget-ip', key: hash(ip || 'unknown'), max: 50 },
      ];
      for (const item of scopes) {
        const row = await db.prepare('SELECT window_start,count FROM auth_rate_limits WHERE scope = ? AND key = ?').get(item.scope, item.key);
        if (row && timestamp - row.window_start < HOUR && row.count >= item.max) {
          throw new HttpError(429, 'Too many mobile verification attempts. Please try again later.', Math.max(1, Math.ceil((HOUR - (timestamp - row.window_start)) / 1000)));
        }
      }
      const update = db.prepare(`INSERT INTO auth_rate_limits(scope,key,window_start,count,last_sent) VALUES (?,?,?,1,?)
        ON CONFLICT(scope,key) DO UPDATE SET
        count = CASE WHEN ? - auth_rate_limits.window_start >= ? THEN 1 ELSE auth_rate_limits.count + 1 END,
        window_start = CASE WHEN ? - auth_rate_limits.window_start >= ? THEN ? ELSE auth_rate_limits.window_start END,
        last_sent = excluded.last_sent`);
      for (const item of scopes) await update.run(item.scope, item.key, timestamp, timestamp, timestamp, HOUR, timestamp, HOUR, timestamp);
      await db.prepare("INSERT INTO widget_token_uses(token_hash,browser_id,created_at,expires_at,status) VALUES (?,?,?,?,'verifying')")
        .run(tokenHash, browser.id, timestamp, timestamp + 24 * HOUR);
    });
  }

  async function handle(req, pathname, res, browser, readJson) {
    if (req.method !== 'POST' || !pathname.startsWith('/api/auth/')) return undefined;
    if (pathname === '/api/auth/msg91') {
      if (!providers.widget) throw new HttpError(503, 'Mobile widget sign-in is not configured. Please contact the store owner.');
      const body = await readJson(req);
      const mode = modeFor(body.mode);
      const active = await checkMode(browser, mode);
      const accessToken = typeof body.accessToken === 'string' ? body.accessToken.trim() : '';
      if (!accessToken || accessToken.length > 12_000 || /[\u0000-\u0020\u007f]/.test(accessToken)) {
        throw new HttpError(422, 'Mobile verification did not provide a valid access token. Please try again.');
      }
      const tokenHash = hash(accessToken);
      await reserveWidgetToken(active, tokenHash, clientAddress(req));
      try {
        const verified = await providers.widget.verifyAccessToken(accessToken);
        let mobile;
        try { mobile = normalizeMobile(verified); }
        catch { throw new HttpError(401, 'Mobile verification did not confirm a valid Indian mobile number. Please verify again.'); }
        await completeIdentity(browser, { provider: 'mobile', subject: mobile, phone: `+${mobile}` }, mode, res, undefined, tokenHash);
      } catch (error) {
        await db.prepare("UPDATE widget_token_uses SET status = 'failed' WHERE token_hash = ? AND status = 'verifying'").run(tokenHash);
        if (error instanceof HttpError) throw error;
        throw new HttpError(502, 'The mobile verification service could not complete this request. Please try again later.');
      }
      return { state: true };
    }
    if (pathname === '/api/auth/google') {
      if (!providers.google) throw new HttpError(503, 'Google sign-in is not configured. Please contact the store owner.');
      const body = await readJson(req);
      const mode = modeFor(body.mode);
      await checkMode(browser, mode);
      if (typeof body.idToken !== 'string' || body.idToken.length < 1 || body.idToken.length > 12_000) throw new HttpError(422, 'Google sign-in did not provide a valid token. Please try again.');
      let claims;
      try { claims = await providers.google.verifyIdToken(body.idToken); }
      catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(401, 'Google could not verify this sign-in. Please sign in again.'); }
      const seconds = Math.floor(now() / 1000);
      if (!claims || typeof claims.uid !== 'string' || !claims.uid || claims.uid.length > 128 || claims.firebase?.sign_in_provider !== 'google.com'
        || claims.email_verified !== true || typeof claims.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)
        || claims.email.length > 254 || !Number.isInteger(claims.auth_time) || seconds - claims.auth_time > 300 || claims.auth_time > seconds + 30) {
        throw new HttpError(401, 'Please complete a fresh Google sign-in with a verified email address.');
      }
      await completeIdentity(browser, { provider: 'google', subject: claims.uid, email: claims.email.toLowerCase(), name: typeof claims.name === 'string' ? claims.name.slice(0, 100) : '' }, mode, res);
      return { state: true };
    }
    if (pathname === '/api/auth/otp/send') {
      if (!providers.mobile) throw new HttpError(503, 'Mobile sign-in is not configured. Please contact the store owner.');
      const body = await readJson(req);
      const mobile = normalizeMobile(body.mobile);
      const mode = modeFor(body.mode);
      const active = await checkMode(browser, mode);
      await reserveSend(active, mobile, clientAddress(req));
      const challengeId = randomUUID();
      const expiresAt = now() + 5 * 60_000;
      await transactionAsync(db, async () => {
        await db.prepare("UPDATE otp_challenges SET status = 'failed' WHERE mobile = ? AND status IN ('sending','pending')").run(mobile);
        await db.prepare("INSERT INTO otp_challenges(id,browser_id,mobile,mode,expires_at,status,created_at) VALUES (?,?,?,?,?,'sending',?)")
          .run(challengeId, active.id, mobile, mode, expiresAt, now());
      });
      try {
        await providers.mobile.sendOtp(mobile);
        const result = await db.prepare("UPDATE otp_challenges SET status = 'pending' WHERE id = ? AND status = 'sending'").run(challengeId);
        if (!result.changes) throw new HttpError(401, 'This verification has expired. Request a new code.');
      } catch (error) {
        await db.prepare("UPDATE otp_challenges SET status = 'failed' WHERE id = ?").run(challengeId);
        if (error instanceof HttpError) throw error;
        throw new HttpError(502, 'The SMS service could not send a code. Please try again later.');
      }
      return { challengeId, expiresAt: new Date(expiresAt).toISOString(), retryAfter: 60 };
    }
    if (pathname === '/api/auth/otp/verify') {
      if (!providers.mobile) throw new HttpError(503, 'Mobile sign-in is not configured. Please contact the store owner.');
      const body = await readJson(req);
      if (typeof body.challengeId !== 'string' || !/^[a-f0-9-]{36}$/i.test(body.challengeId) || typeof body.otp !== 'string' || !/^\d{6}$/.test(body.otp)) throw new HttpError(422, 'Enter the six-digit verification code.');
      const challenge = await transactionAsync(db, async () => {
        const row = await db.prepare('SELECT * FROM otp_challenges WHERE id = ? AND browser_id = ?').get(body.challengeId, browser.id);
        if (!row || row.expires_at <= now() || row.status !== 'pending' || row.attempts >= 5) throw new HttpError(401, 'This verification has expired or is unavailable. Request a new code.');
        await checkMode(browser, row.mode);
        await db.prepare("UPDATE otp_challenges SET status = 'verifying',attempts = attempts + 1 WHERE id = ?").run(row.id);
        return row;
      });
      let valid;
      try { valid = await providers.mobile.verifyOtp(challenge.mobile, body.otp); }
      catch (error) {
        await db.prepare("UPDATE otp_challenges SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END WHERE id = ? AND status = 'verifying'").run(challenge.id);
        if (error instanceof HttpError) throw error;
        throw new HttpError(502, 'The SMS service could not verify this code. Please try again later.');
      }
      if (valid !== true) {
        await db.prepare("UPDATE otp_challenges SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END WHERE id = ? AND status = 'verifying'").run(challenge.id);
        throw new HttpError(401, 'The verification code is incorrect or expired. Please try again.');
      }
      try {
        await completeIdentity(browser, { provider: 'mobile', subject: challenge.mobile, phone: `+${challenge.mobile}` }, challenge.mode, res, challenge.id);
      } catch (error) {
        await db.prepare("UPDATE otp_challenges SET status = 'failed' WHERE id = ?").run(challenge.id);
        throw error;
      }
      return { state: true };
    }
    if (pathname === '/api/auth/logout') {
      const result = await transactionAsync(db, async () => {
        await activeBrowser(browser);
        await db.prepare('DELETE FROM browser_sessions WHERE id = ?').run(browser.id);
        return await newBrowser(await newOwner());
      });
      finishRotation(browser, result, res);
      return { state: true };
    }
    return undefined;
  }

  return { sessionFor, requireAuthenticated, authState, handle };
}
