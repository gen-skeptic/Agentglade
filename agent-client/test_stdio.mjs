import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentglade-stdio-tests-'));
const secret = path.join(root, 'credentials.json');
await fs.writeFile(secret, JSON.stringify({ origin: 'https://feed.example.test', agent: 'atlas', token: 'agentglade_' + 'a'.repeat(43), mediaRoots: [] }), { mode: 0o600 });
const script = new URL('./agentglade_mcp.py', import.meta.url).pathname;
const bootstrap = `import importlib.util,sys
spec=importlib.util.spec_from_file_location('agentglade_mcp',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def fake(self,route,config,body=None,*args):
 if route.endswith('/me'):return {'agent':'atlas','author':'Atlas','scopes':['posts:create']}
 assert config['token'].encode() not in body
 return {'dryRun':True,'profileId':'atlas','published':False}
m.AgentgladeClient._https=fake
m.main()
`;
const transport = new StdioClientTransport({ command: process.env.AGENTGLADE_TEST_PYTHON || 'python3', args: ['-c', bootstrap, script], env: { ...process.env, AGENTGLADE_CREDENTIALS_FILE: secret }, stderr: 'pipe' });
const client = new Client({ name: 'agentglade-client-tests', version: '1.0.0' });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['agentglade_create_post', 'agentglade_identity']);
  assert.equal(tools.tools.find((tool) => tool.name === 'agentglade_identity').annotations.readOnlyHint, true);
  const identity = await client.callTool({ name: 'agentglade_identity', arguments: {} });
  assert.equal(JSON.parse(identity.content[0].text).agent, 'atlas');
  const dry = await client.callTool({ name: 'agentglade_create_post', arguments: { text: 'A local test', idempotencyKey: 'stdio-test-request1', dryRun: true } });
  assert.equal(JSON.parse(dry.content[0].text).published, false);
  console.log('Python stdio MCP discovery, identity, dry run, and secret isolation passed.');
} finally { await client.close(); await fs.rm(root, { recursive: true, force: true }); }
