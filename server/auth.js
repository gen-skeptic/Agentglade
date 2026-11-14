import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
export const hashSecret = (value) => crypto.createHash('sha256').update(value).digest('hex');
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 32);
  return `scrypt$${salt}$${hash.toString('hex')}`;
}
async function verifyPassword(password, encoded) {
  const [, salt, expected] = encoded.split('$');
  const actual = await scrypt(password, salt, 32);
  return crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
const reply = (res, status, value, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
};
export async function createHumanAuth({ configFile, origin }) {
  const config = configFile ? JSON.parse(await fs.readFile(configFile, 'utf8')) : {};
  const admin = config.localAdmin;
  if (admin && (!/^[a-z][a-z0-9-]{0,47}$/.test(admin.username || '') || !/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(admin.passwordHash || ''))) throw new Error('Invalid local administrator configuration.');
  const proxyHash = config.proxyTokenHash;
  if (proxyHash && !/^[a-f0-9]{64}$/.test(proxyHash)) throw new Error('Invalid proxy credential hash.');
  const sessions = new Map(), attempts = new Map();
  const maxAge = 8 * 60 * 60 * 1000;
  const secure = new URL(origin).protocol === 'https:';
  const cookie = (value, age) => `agentglade_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const sessionToken = (req) => /(?:^|;\s*)agentglade_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  const localSubject = admin ? `local:${admin.username}` : null;
  function sameOrigin(req) {
    return req.headers.origin === origin && (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin');
  }
  return {
    localSubject,
    localAccount: admin ? { name: admin.name || admin.username, profileId: 'admin' } : null,
    identity(req) {
      // Automation keys can never be combined with a browser session or proxy identity.
      if (req.headers.authorization) return null;
      const now = Date.now(), token = sessionToken(req), saved = sessions.get(token);
      if (saved && saved.expires > now) return { user: localSubject, name: admin.name || admin.username, displayName: admin.name || admin.username, proxyRole: '' };
      if (saved) sessions.delete(token);
      // Identity headers are ignored unless the configured proxy supplies its private marker.
      const key = req.headers['x-agentglade-proxy-key'];
      if (!proxyHash || typeof key !== 'string' || !crypto.timingSafeEqual(Buffer.from(hashSecret(key), 'hex'), Buffer.from(proxyHash, 'hex'))) return null;
      const user = req.headers['remote-user'];
      if (typeof user !== 'string' || !user || user.length > 512 || /^(?:local|agent):/.test(user) || /[\x00-\x20\x7f]/.test(user)) return null;
      return { user, name: req.headers['remote-name'] || user, displayName: req.headers['remote-name'] || '', proxyRole: req.headers['remote-role'] || '' };
    },
    async handle(req, res, pathname) {
      if (!['/api/auth/login', '/api/auth/logout'].includes(pathname)) return false;
      if (req.method !== 'POST') { reply(res, 405, { error: 'Use POST.' }, { Allow: 'POST' }); return true; }
      if (!sameOrigin(req)) { reply(res, 403, { error: 'Cross-site login refused.' }); return true; }
      if (pathname.endsWith('/logout')) {
        sessions.delete(sessionToken(req)); reply(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) }); return true;
      }
      const now = Date.now();
      for (const [key, value] of attempts) if (now - value.started >= 60000) attempts.delete(key);
      // Ignore caller-supplied forwarding headers when limiting password attempts.
      const ip = req.socket.remoteAddress, rate = attempts.get(ip) || { started: now, count: 0 };
      attempts.set(ip, rate);
      if (++rate.count > 10 || attempts.size > 10000) { reply(res, 429, { error: 'Too many sign-in attempts. Retry in a minute.' }); return true; }
      let size = 0; const chunks = [];
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > 4096) { req.resume(); reply(res, 413, { error: 'Login request too large.' }); return true; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { reply(res, 400, { error: 'Invalid login request.' }); return true; }
      if (!body || typeof body !== 'object') { reply(res, 400, { error: 'Invalid login request.' }); return true; }
      if (!admin || body.username !== admin.username || typeof body.password !== 'string' || body.password.length > 256 || !await verifyPassword(body.password, admin.passwordHash)) {
        reply(res, 401, { error: 'Invalid username or password.' }); return true;
      }
      for (const [token, value] of sessions) if (value.expires <= now) sessions.delete(token);
      if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value);
      const token = crypto.randomBytes(32).toString('hex'); sessions.set(token, { expires: now + maxAge });
      reply(res, 200, { ok: true }, { 'Set-Cookie': cookie(token, maxAge / 1000) }); return true;
    },
  };
}
