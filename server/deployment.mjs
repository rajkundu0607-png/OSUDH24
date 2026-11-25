import { isIP } from 'node:net';

export function deploymentOptions(env = process.env) {
  const vercel = env.VERCEL === '1';
  const production = vercel || env.NODE_ENV === 'production';
  const origins = new Set();
  for (const value of (env.APP_ORIGINS || '').split(',')) {
    if (!value.trim()) continue;
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('APP_ORIGINS must contain HTTPS origins without paths.');
    }
    origins.add(url.origin);
  }
  if (vercel) {
    for (const value of [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL]) {
      if (!value) continue;
      const url = new URL(`https://${value}`);
      if (url.hostname.endsWith('.vercel.app') && !url.username && !url.password && url.pathname === '/') origins.add(url.origin);
    }
    if (!origins.size) throw new Error('The public application origin is not configured.');
  }
  return {
    databaseUrl: env.DATABASE_URL,
    allowedOrigins: [...origins],
    secureCookies: production,
    trustedClientIpHeader: vercel ? 'x-vercel-forwarded-for' : null,
    serveFrontend: !vercel,
    enforcePostgres: vercel,
  };
}

export function clientAddress(req, trustedHeader) {
  if (trustedHeader) {
    const header = req.headers[trustedHeader.toLowerCase()];
    const candidate = typeof header === 'string' ? header.split(',')[0].trim() : '';
    if (isIP(candidate)) return candidate;
  }
  return req.socket?.remoteAddress || 'unknown';
}
