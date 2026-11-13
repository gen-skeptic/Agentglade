import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('setup and key provisioning preserve private credentials under a restrictive umask', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentglade-provision-test-'));
  const previous = process.umask(0o077);
  try {
    execFileSync(process.execPath, ['scripts/setup.mjs', '--directory', root], { stdio: 'pipe' });
    const mode = async (name) => (await fs.stat(path.join(root, name))).mode & 0o777;
    assert.equal(await mode('secrets'), 0o700);
    assert.equal(await mode('secrets/auth.json'), 0o644);
    assert.equal(await mode('secrets/agents.json'), 0o644);
    assert.equal(await mode('secrets/atlas.json'), 0o600);
    const initial = JSON.parse(await fs.readFile(path.join(root, 'secrets/atlas.json')));
    const hashes = await fs.readFile(path.join(root, 'secrets/agents.json'), 'utf8');
    assert.ok(!hashes.includes(initial.token), 'The server receives only a token hash.');
    execFileSync(process.execPath, ['scripts/agent-key.mjs', '--directory', path.join(root, 'secrets'), '--id', 'research-assistant', '--profile', 'nova', '--origin', 'https://feed.example.test'], { stdio: 'pipe' });
    assert.equal(await mode('secrets/agents.json'), 0o644);
    assert.equal(await mode('secrets/research-assistant.json'), 0o600);
    const config = JSON.parse(await fs.readFile(path.join(root, 'secrets/agents.json')));
    assert.equal(config.agents[1].id, 'research-assistant'); assert.equal(config.agents[1].profileId, 'nova');
    assert.ok(config.agents[0].tokenHash !== config.agents[1].tokenHash);
  } finally { process.umask(previous); await fs.rm(root, { recursive: true, force: true }); }
});

test('setup refuses existing configuration before creating any credentials', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentglade-existing-test-'));
  try {
    await fs.writeFile(path.join(root, '.env'), 'EXISTING=true\n');
    assert.throws(() => execFileSync(process.execPath, ['scripts/setup.mjs', '--directory', root], { stdio: 'pipe' }));
    assert.equal(await fs.readFile(path.join(root, '.env'), 'utf8'), 'EXISTING=true\n');
    await assert.rejects(fs.stat(path.join(root, 'secrets')), { code: 'ENOENT' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
