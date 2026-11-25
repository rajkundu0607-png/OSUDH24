import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { openStorage, snapshotAsync, transactionAsync } from './storage.mjs';
import { appointmentDates, appointmentTimes } from './catalog.mjs';
import { HttpError } from './errors.mjs';
import { createAuthProviders } from './auth-providers.mjs';
import { createAuthManager } from './auth.mjs';
import { clientAddress } from './deployment.mjs';
const MAX_UPLOAD = 10 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
}
function readBody(req, limit) {
    return new Promise((resolveBody, reject) => {
        if (Number(req.headers['content-length']) > limit) {
            req.resume();
            reject(new HttpError(413, 'The uploaded data is too large.'));
            return;
        }
        const chunks = [];
        let size = 0;
        let exceeded = false;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > limit) {
                if (!exceeded)
                    reject(new HttpError(413, 'The uploaded data is too large.'));
                exceeded = true;
                chunks.length = 0;
            }
            else if (!exceeded)
                chunks.push(chunk);
        });
        req.on('end', () => { if (!exceeded)
            resolveBody(Buffer.concat(chunks)); });
        req.on('error', reject);
        req.on('aborted', () => reject(new HttpError(400, 'The request was interrupted.')));
    });
}
async function readJson(req) {
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
        throw new HttpError(415, 'Send this request as application/json.');
    }
    try {
        const body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body))
            throw new Error('object required');
        return body;
    }
    catch (error) {
        if (error instanceof HttpError)
            throw error;
        throw new HttpError(400, 'The request must contain a valid JSON object.');
    }
}
function text(value, label, { max = 200, min = 1 } = {}) {
    if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new HttpError(422, `Enter a valid ${label}.`);
    }
    return value.trim();
}
function email(value) {
    const address = text(value, 'email address', { max: 254 });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))
        throw new HttpError(422, 'Enter a valid email address.');
    return address.toLowerCase();
}
function pin(value) {
    if (typeof value !== 'string' || !/^\d{6}$/.test(value))
        throw new HttpError(422, 'Enter a six-digit PIN code.');
    return value;
}
function profile(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new HttpError(422, 'Enter your profile and delivery details.');
    const clean = {
        name: text(value.name, 'full name', { max: 100 }),
        email: email(value.email),
        phone: text(value.phone, 'mobile number', { max: 10 }),
        address: text(value.address, 'street address', { min: 5 }),
        city: text(value.city, 'city', { max: 100 }),
        pin: pin(value.pin),
    };
    if (!/^[6-9]\d{9}$/.test(clean.phone))
        throw new HttpError(422, 'Enter a ten-digit Indian mobile number.');
    return clean;
}
function checkOrigin(req, allowedOrigins) {
    let host;
    try {
        host = new URL(`http://${req.headers.host}`);
    }
    catch {
        throw new HttpError(400, 'Invalid request host.');
    }
    if (host.username || host.password || host.host.toLowerCase() !== String(req.headers.host).toLowerCase())
        throw new HttpError(400, 'Invalid request host.');
    const deployed = allowedOrigins.length > 0;
    const allowed = new Set(deployed ? allowedOrigins : [host.origin, 'http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:4173', 'http://localhost:4173']);
    if (deployed ? !allowedOrigins.some(origin => new URL(origin).host.toLowerCase() === host.host.toLowerCase()) : !['127.0.0.1', 'localhost'].includes(host.hostname)) {
        throw new HttpError(403, 'This request host is not allowed.');
    }
    if (req.headers['sec-fetch-site'] === 'cross-site')
        throw new HttpError(403, 'Cross-site requests are not allowed.');
    if (req.headers.origin) {
        if (!allowed.has(req.headers.origin))
            throw new HttpError(403, 'Cross-origin requests are not allowed.');
    }
}
function verifyFile(content, mime) {
    if (!content.length)
        throw new HttpError(422, 'Choose a non-empty prescription file.');
    const signatures = {
        'application/pdf': Buffer.from('%PDF-'),
        'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        'image/jpeg': Buffer.from([0xff, 0xd8, 0xff]),
    };
    const signature = signatures[mime];
    if (!signature)
        throw new HttpError(415, 'Choose a JPG, PNG or PDF file.');
    if (!content.subarray(0, signature.length).equals(signature))
        throw new HttpError(422, 'The file contents do not match its type.');
}
const staticMime = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
};
function serveFrontendFile(req, res, pathname, distPath) {
    if (!['GET', 'HEAD'].includes(req.method))
        throw new HttpError(405, 'Method not allowed.');
    const root = resolve(distPath);
    let decoded;
    try {
        decoded = decodeURIComponent(pathname);
    }
    catch {
        throw new HttpError(400, 'Invalid URL.');
    }
    const path = resolve(root, `.${decoded}`);
    if (path !== root && !path.startsWith(root + sep))
        throw new HttpError(404, 'Not found.');
    let target = path;
    if (!existsSync(target) || !statSync(target).isFile()) {
        if (extname(pathname))
            throw new HttpError(404, 'Not found.');
        target = resolve(root, 'index.html');
    }
    if (!existsSync(target))
        throw new HttpError(404, 'Build the frontend with pnpm build before starting production mode.');
    res.writeHead(200, { 'Content-Type': staticMime[extname(target)] || 'application/octet-stream', 'Content-Length': statSync(target).size });
    if (req.method === 'HEAD')
        res.end();
    else
        createReadStream(target).on('error', () => res.destroy()).pipe(res);
}
export function createApp({ databasePath = 'data/osudh24.sqlite', databaseUrl, databaseSchema, distPath = 'dist', authProviders, now = Date.now, allowedOrigins = [], secureCookies = false, trustedClientIpHeader = null, serveFrontend = true, enforcePostgres = false } = {}) {
    let contextPromise;
    function getContext() {
        if (!contextPromise)
            contextPromise = (async () => {
                if (enforcePostgres && !databaseUrl)
                    throw new HttpError(503, 'The store database is not configured.');
                const db = await openStorage({ databasePath, databaseUrl, schema: databaseSchema });
                const auth = createAuthManager({ db, providers: authProviders || createAuthProviders(), now, secureCookies,
                    clientAddress: req => clientAddress(req, trustedClientIpHeader) });
                return { db, auth };
            })().catch(error => { contextPromise = undefined; throw error; });
        return contextPromise;
    }
    const handle = async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'same-origin');
        try {
            checkOrigin(req, allowedOrigins);
            const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
            if (!pathname.startsWith('/api/')) {
                if (!serveFrontend)
                    throw new HttpError(404, 'API route not found.');
                return serveFrontendFile(req, res, pathname, distPath);
            }
            const { db, auth } = await getContext();
            if (req.method === 'GET' && pathname === '/api/health') {
                await db.prepare('SELECT 1 AS healthy').get();
                return json(res, 200, { status: 'ok', database: db.dialect });
            }
            const browser = await auth.sessionFor(req, res);
            const expectedAccount = req.headers['x-account-id'];
            if (expectedAccount !== undefined && expectedAccount !== (browser.userId || 'guest')) {
                throw new HttpError(401, 'Your sign-in changed in another tab. Please refresh before continuing.');
            }
            const sessionId = browser.ownerId;
            const state = async () => snapshotAsync(db, browser.ownerId, await auth.authState(browser));
            const done = async (extra = {}, status = 200) => json(res, status, { state: await state(), ...extra });
            if (req.method === 'GET' && pathname === '/api/bootstrap')
                return json(res, 200, await state());
            const authResult = await auth.handle(req, pathname, res, browser, readJson);
            if (authResult)
                return authResult.state ? await done() : json(res, 200, authResult);
            const protectedRoute = (pathname === '/api/profile' && ['PUT', 'DELETE'].includes(req.method))
                || (pathname === '/api/orders' && req.method === 'POST')
                || (/^\/api\/orders\/[^/]+\/cancel$/.test(pathname) && req.method === 'POST')
                || (pathname === '/api/appointments' && req.method === 'POST')
                || (/^\/api\/appointments\/[^/]+\/cancel$/.test(pathname) && req.method === 'POST')
                || (pathname === '/api/prescriptions' && req.method === 'POST')
                || (/^\/api\/prescriptions\/[^/]+\/file$/.test(pathname) && req.method === 'GET')
                || (/^\/api\/prescriptions\/[^/]+$/.test(pathname) && req.method === 'DELETE');
            if (protectedRoute)
                await auth.requireAuthenticated(browser);
            let match;
            if (req.method === 'PUT' && (match = /^\/api\/cart\/items\/(\d+)$/.exec(pathname))) {
                const productId = Number(match[1]);
                if (!await db.prepare('SELECT id FROM products WHERE id = ?').get(productId))
                    throw new HttpError(404, 'Product not found.');
                const { quantity } = await readJson(req);
                if (!Number.isInteger(quantity) || quantity < 0 || quantity > 99)
                    throw new HttpError(422, 'Choose a quantity between 0 and 99.');
                if (quantity === 0)
                    await db.prepare('DELETE FROM cart WHERE session_id = ? AND product_id = ?').run(sessionId, productId);
                else
                    await db.prepare('INSERT INTO cart(session_id,product_id,quantity) VALUES (?,?,?) ON CONFLICT(session_id,product_id) DO UPDATE SET quantity = excluded.quantity').run(sessionId, productId, quantity);
                return await done();
            }
            if (pathname === '/api/profile' && req.method === 'PUT') {
                const clean = profile(await readJson(req));
                await db.prepare('UPDATE sessions SET profile = ? WHERE id = ?').run(JSON.stringify(clean), sessionId);
                return await done();
            }
            if (pathname === '/api/profile' && req.method === 'DELETE') {
                await transactionAsync(db, async () => {
                    for (const table of ['orders', 'appointments', 'prescriptions'])
                        await db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
                    await db.prepare("UPDATE sessions SET profile = '{}',location_pin = '',newsletter_email = '' WHERE id = ?").run(sessionId);
                });
                return await done();
            }
            if (pathname === '/api/location' && req.method === 'PUT') {
                const body = await readJson(req);
                await db.prepare('UPDATE sessions SET location_pin = ? WHERE id = ?').run(pin(body.pin), sessionId);
                return await done();
            }
            if (pathname === '/api/newsletter' && req.method === 'POST') {
                const body = await readJson(req);
                await db.prepare('UPDATE sessions SET newsletter_email = ? WHERE id = ?').run(email(body.email), sessionId);
                return await done();
            }
            if (pathname === '/api/orders' && req.method === 'POST') {
                const key = req.headers['idempotency-key'];
                if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(key))
                    throw new HttpError(422, 'Include a valid Idempotency-Key for this checkout.');
                const body = await readJson(req);
                const clean = profile(body.profile);
                const coupon = typeof body.coupon === 'string' ? body.coupon.trim().toUpperCase() : '';
                if (coupon && coupon !== 'WELCOME10')
                    throw new HttpError(422, 'Coupon not found. Try WELCOME10.');
                const requestHash = hash(JSON.stringify({ profile: clean, coupon }));
                const order = await transactionAsync(db, async () => {
                    const previous = await db.prepare('SELECT data,request_hash FROM orders WHERE session_id = ? AND idempotency_key = ?').get(sessionId, key);
                    if (previous) {
                        if (previous.request_hash !== requestHash)
                            throw new HttpError(409, 'This checkout reference was already used with different details.');
                        return JSON.parse(previous.data);
                    }
                    const rows = await db.prepare('SELECT p.data,c.quantity FROM cart c JOIN products p ON p.id = c.product_id WHERE c.session_id = ? ORDER BY p.id').all(sessionId);
                    if (!rows.length)
                        throw new HttpError(422, 'Your cart is empty. Add a product before checkout.');
                    const items = rows.map(row => { const p = JSON.parse(row.data); return { name: p.name, price: p.price, quantity: row.quantity }; });
                    const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
                    const discount = coupon ? Math.round(subtotal * 0.1) : 0;
                    const shipping = subtotal - discount >= 499 ? 0 : 49;
                    const result = {
                        id: `DEMO-${randomUUID().toUpperCase()}`, date: new Date().toISOString(), items,
                        subtotal, discount, shipping, total: subtotal - discount + shipping,
                        status: 'Demo placed', address: `${clean.name}, ${clean.address}, ${clean.city} ${clean.pin}`,
                    };
                    await db.prepare('INSERT INTO orders(id,session_id,idempotency_key,request_hash,data,created_at) VALUES (?,?,?,?,?,?)').run(result.id, sessionId, key, requestHash, JSON.stringify(result), result.date);
                    await db.prepare('UPDATE sessions SET profile = ? WHERE id = ?').run(JSON.stringify(clean), sessionId);
                    await db.prepare('DELETE FROM cart WHERE session_id = ?').run(sessionId);
                    return result;
                });
                return await done({ order }, 201);
            }
            if (req.method === 'POST' && (match = /^\/api\/orders\/([^/]+)\/cancel$/.exec(pathname))) {
                const row = await db.prepare('SELECT data FROM orders WHERE session_id = ? AND id = ?').get(sessionId, match[1]);
                if (!row)
                    throw new HttpError(404, 'Order not found.');
                const order = { ...JSON.parse(row.data), status: 'Cancelled' };
                await db.prepare('UPDATE orders SET data = ? WHERE id = ? AND session_id = ?').run(JSON.stringify(order), match[1], sessionId);
                return await done();
            }
            if (pathname === '/api/appointments' && req.method === 'POST') {
                const body = await readJson(req);
                const doctor = await db.prepare('SELECT data FROM doctors WHERE id = ?').get(typeof body.doctorId === 'string' ? body.doctorId : '');
                if (!doctor)
                    throw new HttpError(422, 'Choose a doctor from the directory.');
                const patient = text(body.patient, 'patient name', { max: 100 });
                if (!appointmentDates().includes(body.date) || !appointmentTimes.includes(body.time))
                    throw new HttpError(422, 'Choose an available date and time.');
                const appointment = { id: `APT-${randomUUID().toUpperCase()}`, doctorId: body.doctorId, patient, date: body.date, time: body.time, fee: JSON.parse(doctor.data).fee, status: 'Booked' };
                try {
                    await db.prepare('INSERT INTO appointments(id,session_id,doctor_id,patient,date,time,fee,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(appointment.id, sessionId, appointment.doctorId, patient, appointment.date, appointment.time, appointment.fee, appointment.status, new Date().toISOString());
                }
                catch (error) {
                    if (error.code === '23505' || (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(error.message)))
                        throw new HttpError(409, 'This appointment slot has just been booked. Choose another time.');
                    throw error;
                }
                return await done({ appointment }, 201);
            }
            if (req.method === 'POST' && (match = /^\/api\/appointments\/([^/]+)\/cancel$/.exec(pathname))) {
                const result = await db.prepare("UPDATE appointments SET status = 'Cancelled' WHERE id = ? AND session_id = ?").run(match[1], sessionId);
                if (!result.changes)
                    throw new HttpError(404, 'Appointment not found.');
                return await done();
            }
            if (pathname === '/api/prescriptions' && req.method === 'POST') {
                const mime = req.headers['content-type']?.split(';')[0].trim();
                if (!['application/pdf', 'image/jpeg', 'image/png'].includes(mime))
                    throw new HttpError(415, 'Choose a JPG, PNG or PDF file.');
                let name;
                try {
                    name = decodeURIComponent(req.headers['x-file-name'] || '');
                }
                catch {
                    throw new HttpError(422, 'Enter a valid file name.');
                }
                name = text(name.replace(/\\/g, '/').split('/').at(-1), 'file name');
                const content = await readBody(req, MAX_UPLOAD);
                verifyFile(content, mime);
                const prescription = { id: randomUUID(), name, mime, size: content.length, createdAt: new Date().toISOString() };
                await transactionAsync(db, async () => {
                    const quota = await db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size),0) AS total FROM prescriptions WHERE session_id = ?').get(sessionId);
                    if (Number(quota.count) >= 20 || Number(quota.total) + content.length > 50 * 1024 * 1024)
                        throw new HttpError(422, 'Prescription storage is full. Delete an older upload before adding another.');
                    await db.prepare('INSERT INTO prescriptions(id,session_id,name,mime,size,created_at,content) VALUES (?,?,?,?,?,?,?)').run(prescription.id, sessionId, name, mime, content.length, prescription.createdAt, content);
                });
                return await done({ prescription }, 201);
            }
            if (req.method === 'GET' && (match = /^\/api\/prescriptions\/([^/]+)\/file$/.exec(pathname))) {
                const file = await db.prepare('SELECT * FROM prescriptions WHERE id = ? AND session_id = ?').get(match[1], sessionId);
                if (!file)
                    throw new HttpError(404, 'Prescription not found.');
                res.writeHead(200, { 'Content-Type': file.mime, 'Content-Disposition': `attachment; filename="prescription${file.mime === 'application/pdf' ? '.pdf' : file.mime === 'image/png' ? '.png' : '.jpg'}"; filename*=UTF-8''${encodeURIComponent(file.name)}` });
                const content = Buffer.from(file.content);
                function* chunks() { for (let offset = 0; offset < content.length; offset += 65536)
                    yield content.subarray(offset, offset + 65536); }
                await pipeline(Readable.from(chunks()), res);
                return;
            }
            if (req.method === 'DELETE' && (match = /^\/api\/prescriptions\/([^/]+)$/.exec(pathname))) {
                const result = await db.prepare('DELETE FROM prescriptions WHERE id = ? AND session_id = ?').run(match[1], sessionId);
                if (!result.changes)
                    throw new HttpError(404, 'Prescription not found.');
                return await done();
            }
            throw new HttpError(404, 'API route not found.');
        }
        catch (error) {
            if (error instanceof HttpError && error.retryAfter)
                res.setHeader('Retry-After', error.retryAfter);
            if (!res.headersSent)
                json(res, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'The server could not complete your request. Please try again.' });
            else
                res.destroy();
            if (!(error instanceof HttpError))
                console.error('API request failed:', error.code || error.name);
        }
    };
    const server = createServer(handle);
    server.requestTimeout = 30000;
    server.headersTimeout = 10000;
    server.keepAliveTimeout = 5000;
    let closing;
    return {
        server,
        handle,
        close() {
            if (!closing)
                closing = (async () => {
                    if (server.listening) {
                        await new Promise((resolveClose, reject) => {
                            server.close(error => error ? reject(error) : resolveClose());
                            server.closeIdleConnections();
                        });
                    }
                    if (contextPromise) {
                        const context = await contextPromise.catch(() => null);
                        if (context)
                            await context.db.close();
                    }
                })();
            return closing;
        },
    };
}
