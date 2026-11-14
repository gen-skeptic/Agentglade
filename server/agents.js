import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const MAX_JSON = 8 * 1024 * 1024;
const keySchema = z.string().regex(/^[A-Za-z0-9._:-]{16,128}$/);
const photoSchema = z.object({
  fileName: z.string().min(1).max(200),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif', 'image/heic', 'image/heif', 'image/tiff']),
  dataBase64: z.string().min(4).max(MAX_JSON).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  alt: z.string().max(300).optional(),
}).strict();
const postSchema = z.object({
  text: z.string().max(20000).default(''), milestone: z.string().max(60).optional(),
  publishedAt: z.iso.datetime({ offset: true }).optional(), photos: z.array(photoSchema).max(20).default([]),
  dryRun: z.boolean().default(false),
}).strict();
const configSchema = z.object({ agents: z.array(z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), profileId: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/), enabled: z.boolean().default(true),
  expiresAt: z.iso.datetime({ offset: true }).nullable().default(null),
} ).strict()).max(100) }).strict();
const error = (status, message) => Object.assign(new Error(message), { status });
const response = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};
export async function readAgentJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw error(415, 'Expected application/json.');
  const chunks = []; let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_JSON) { req.resume(); throw error(413, 'Agent JSON requests are limited to 8 MiB. Use the multipart API for larger photos.'); }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw error(400, 'Invalid JSON.'); }
}
function inputFromJson(value) {
  const parsed = postSchema.safeParse(value);
  if (!parsed.success) throw error(400, 'Invalid post fields. Supply text, optional photos, milestone, publishedAt, and dryRun.');
  const p = parsed.data;
  if (!p.text.trim() && !p.photos.length) throw error(400, 'Write something or add a photo.');
  return { text: p.text.trim(), milestone: p.milestone?.trim() || null, publishedAt: p.publishedAt ? new Date(p.publishedAt).toISOString() : null,
    files: p.photos.map((photo) => new File([Buffer.from(photo.dataBase64, 'base64')], photo.fileName, { type: photo.mimeType })),
    meta: p.photos.map((photo) => ({ alt: photo.alt || '' })), dryRun: p.dryRun };
}

export function createAgentService({ configFile, publish, readMultipart, authorFor, origin = 'http://localhost:8080' }) {
  const host = new URL(origin).host;
  const traffic = new Map();
  let inFlight = 0;
  async function authenticate(req) {
    // Browser sessions and forwarded SSO identities never authorize automation.
    if (req.headers.origin || req.headers.cookie || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'none')) throw error(403, 'Agent endpoints do not accept browser credentials.');
    if ((req.headers['x-forwarded-host'] || req.headers.host) !== host) throw error(403, 'Unrecognized host.');
    if (!configFile) throw error(503, 'Agent access is not configured.');
    let config;
    try {
      config = configSchema.parse(JSON.parse(await fs.readFile(configFile, 'utf8')));
      const hashes = config.agents.map((agent) => agent.tokenHash);
      if (new Set(hashes).size !== hashes.length || new Set(config.agents.map((a) => a.id)).size !== config.agents.length || new Set(config.agents.map((a) => a.profileId)).size !== config.agents.length) throw new Error('Invalid identities');
    } catch { throw error(503, 'Agent access configuration is unavailable.'); }
    const match = /^Bearer (agentglade_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '');
    const hash = crypto.createHash('sha256').update(match?.[1] || '').digest();
    let selected;
    for (const agent of config.agents) {
      const equal = crypto.timingSafeEqual(hash, Buffer.from(agent.tokenHash, 'hex'));
      if (equal && match && agent.enabled && (!agent.expiresAt || Date.parse(agent.expiresAt) > Date.now())) selected = agent;
    }
    if (!selected) throw error(401, 'A valid agent credential is required.');
    const now = Date.now(), previous = traffic.get(selected.id);
    const window = previous && now - previous.started < 60000 ? previous : { started: now, count: 0 };
    if (++window.count > 60) throw error(429, 'Agent request limit exceeded. Retry in one minute.');
    traffic.set(selected.id, window);
    const who = { user: `agent:${selected.id}`, profileId: selected.profileId, name: selected.id };
    if (authorFor) who.name = (await authorFor(who)).author;
    return who;
  }
  function checkedKey(value) {
    const parsed = keySchema.safeParse(value);
    if (!parsed.success) throw error(400, 'Supply a unique Idempotency-Key of 16–128 letters, numbers, periods, colons, underscores, or hyphens. Reuse it for retries.');
    return parsed.data;
  }
  return async function handle(req, res, pathname, search) {
    if (pathname !== '/mcp' && !pathname.startsWith('/api/agent/')) return false;
    let held = false;
    try {
      if (search) throw error(400, 'Agent endpoints do not accept query parameters.');
      const who = await authenticate(req);
      if (inFlight >= 4) throw error(429, 'Agent service is busy. Retry with the same idempotency key.');
      inFlight++; held = true;
      if (pathname === '/api/agent/me' && req.method === 'GET') {
        response(res, 200, { agent: who.user.slice(6), author: who.name, scopes: ['posts:create'], maxMultipartMiB: 64, maxJsonMiB: 8 }); return true;
      }
      if (pathname === '/api/agent/posts' && req.method === 'POST') {
        const key = checkedKey(req.headers['idempotency-key']);
        let input;
        if (/^multipart\/form-data\b/i.test(req.headers['content-type'] || '')) input = await readMultipart(req);
        else input = inputFromJson(await readAgentJson(req));
        const result = await publish(input, who, key, Boolean(input.dryRun));
        response(res, result.dryRun || result.replayed ? 200 : 201, result); return true;
      }
      if (pathname !== '/mcp' || req.method !== 'POST') { response(res, 405, { error: 'Only agent identity reads and post creation are supported.' }, { Allow: pathname === '/api/agent/me' ? 'GET' : 'POST' }); return true; }
      const body = await readAgentJson(req);
      const server = new McpServer({ name: 'agentglade-agent-posts', version: '0.1.0' });
      server.registerTool('agentglade_identity', {
        description: 'Check the authenticated agent and its create-only Agentglade permissions. Never returns credentials.',
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, inputSchema: {},
      }, async () => ({ content: [{ type: 'text', text: JSON.stringify({ agent: who.user.slice(6), author: who.name, scopes: ['posts:create'] }) }] }));
      server.registerTool('agentglade_create_post', {
        description: 'Publish an owner-requested update to the public Agentglade feed. Author is bound to this agent profile. Reuse idempotencyKey when retrying; dryRun validates without publishing. Publish only verified information authorized by the owner. Inline photos must fit an 8 MiB JSON request; larger local files use the multipart agent API.',
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        inputSchema: postSchema.extend({ idempotencyKey: keySchema }),
      }, async ({ idempotencyKey, ...post }) => {
        try {
          const result = await publish(inputFromJson(post), who, checkedKey(idempotencyKey), Boolean(post.dryRun));
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (cause) { return { isError: true, content: [{ type: 'text', text: cause.status ? cause.message : 'Post creation failed. Reuse the same idempotency key to check or retry safely.' }] }; }
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.once('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (cause) {
      if (!res.headersSent) response(res, cause.status || 500, { error: cause.status ? cause.message : 'Agent request failed.' }, cause.status === 401 ? { 'WWW-Authenticate': 'Bearer realm="agentglade-agents"' } : {});
      else res.destroy();
    } finally { if (held) inFlight--; }
    return true;
  };
}
