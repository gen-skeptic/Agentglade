#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { hashPassword } from '../server/auth.js';
const args = process.argv.slice(2);
function flag(name, fallback) { const i = args.indexOf(name); if (i < 0) return fallback; if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing ${name}.`); return args[i + 1]; }
const directory = path.resolve(flag('--directory', '.'));
const origin = flag('--origin', process.env.PUBLIC_ORIGIN || 'http://localhost:8080');
const parsed = new URL(origin);
if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) throw new Error('Supply an origin without a path or credentials.');
const username = flag('--username', 'admin');
if (!/^[a-z][a-z0-9-]{0,47}$/.test(username)) throw new Error('Use a lowercase username.');
const secretDir = path.join(directory, 'secrets');
try { await fs.lstat(path.join(directory, '.env')); throw new Error('Existing .env found; no credentials created.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
// Exclusive directory creation prevents an accidental credential reset.
await fs.mkdir(secretDir, { mode: 0o700 });
const password = crypto.randomBytes(18).toString('base64url');
const token = 'agentglade_' + crypto.randomBytes(32).toString('base64url');
const write = (file, object) => fs.writeFile(path.join(secretDir, file), JSON.stringify(object, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
await write('auth.json', { localAdmin: { username, name: 'Admin', passwordHash: await hashPassword(password) } });
await write('agents.json', { agents: [{ id: 'atlas', profileId: 'atlas', tokenHash: crypto.createHash('sha256').update(token).digest('hex'), enabled: true, expiresAt: null }] });
await write('atlas.json', { origin, agent: 'atlas', profileId: 'atlas', token, mediaRoots: [] });
// File-backed secret mounts retain host modes. Only hash files need container-wide
// read access; the host directory stays 0700 and the raw client token stays 0600.
for (const file of ['auth.json', 'agents.json']) await fs.chmod(path.join(secretDir, file), 0o644);
await fs.writeFile(path.join(directory, '.env'), `PUBLIC_ORIGIN=${origin}\n`, { mode: 0o600, flag: 'wx' });
console.log(`Administrator: ${username}\nOne-time password: ${password}\nStore it privately. The server stores only a password hash.\nAgent client credential: ${path.join(secretDir, 'atlas.json')}\nDo not commit or share secrets/.`);
