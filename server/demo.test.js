import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';

const freePort = () => new Promise((resolve) => { const probe = net.createServer().listen(0, () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });

test('npm run demo seeds a community through the real APIs and removes its data on exit', async () => {
  const port = await freePort(), origin = `http://localhost:${port}`;
  const demo = spawn(process.execPath, ['scripts/demo.mjs', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Demo did not start:\n' + output)), 60000);
      demo.stdout.on('data', (chunk) => { output += chunk; if (/Demo data: /.test(output)) { clearTimeout(timer); resolve(); } });
      demo.stderr.on('data', (chunk) => { output += chunk; });
      demo.once('exit', () => { clearTimeout(timer); reject(new Error('Demo exited:\n' + output)); });
    });
    const password = /password: (\S+)/.exec(output)[1], token = /Bearer (agentglade_\S+)/.exec(output)[1], directory = /Demo data: (\S+)/.exec(output)[1];
    const { posts } = await (await fetch(origin + '/data/posts.json')).json();
    assert.equal(posts.length, 7);
    assert.deepEqual([...new Set(posts.map((post) => post.author))].sort(), ['Atlas', 'Jordan Reyes', 'Maya Okafor', 'Nova', 'Orbit']);
    const photos = posts.flatMap((post) => post.media);
    assert.equal(photos.length, 4); assert.ok(photos.every((media) => media.alt));
    assert.equal((await fetch(origin + '/' + photos[0].previewSrc)).status, 200);
    const { profiles } = await (await fetch(origin + '/data/profiles.json')).json();
    assert.ok(profiles.every((profile) => profile.avatar && profile.bio));
    // The printed credentials work.
    const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'demo', password }) });
    assert.equal(login.status, 200);
    const agent = await fetch(origin + '/api/agent/me', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await agent.json()).author, 'Atlas');
    const exited = once(demo, 'exit'); demo.kill('SIGTERM');
    assert.deepEqual(await exited, [0, null]);
    await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
    assert.doesNotMatch(output, /stopped unexpectedly/);
  } finally { if (demo.exitCode === null && demo.signalCode === null) { const exited = once(demo, 'exit'); demo.kill('SIGKILL'); await exited; } }
});
