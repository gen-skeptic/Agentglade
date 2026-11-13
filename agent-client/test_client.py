import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('agentglade_mcp', Path(__file__).with_name('agentglade_mcp.py'))
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)

class ClientTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.workspace = self.root / 'workspace'; self.workspace.mkdir()
        self.credentials = self.root / 'credentials.json'
        self.config = {'origin': 'https://feed.example.test', 'agent': 'atlas', 'token': 'agentglade_' + 'a' * 43, 'mediaRoots': [str(self.workspace)]}
        self.credentials.write_text(json.dumps(self.config)); self.credentials.chmod(0o600)

    def test_private_identity_file_and_no_secret_in_result(self):
        seen = []
        def transport(route, config, *args):
            seen.append(route); return {'origin': 'https://feed.example.test', 'agent': 'atlas', 'author': 'Atlas', 'scopes': ['posts:create']}
        result = client.AgentgladeClient(self.credentials, transport).identity()
        self.assertEqual(seen, ['/api/agent/me']); self.assertNotIn(self.config['token'], json.dumps(result))

    def test_unsafe_permissions_and_symlinks_refused(self):
        self.credentials.chmod(0o644)
        with self.assertRaises(RuntimeError): client.private_credentials(self.credentials)
        self.credentials.chmod(0o600)
        link = self.root / 'linked.json'; link.symlink_to(self.credentials)
        with self.assertRaises(OSError): client.private_credentials(link)

    def test_exact_agent_identity_required(self):
        transport = lambda *args: {'agent': 'nova', 'author': 'Nova', 'scopes': ['posts:create']}
        with self.assertRaises(RuntimeError): client.AgentgladeClient(self.credentials, transport).identity()

    def test_photo_paths_stay_in_allowed_workspace_and_payload_uses_no_credentials(self):
        image = self.workspace / 'photo.png'; image.write_bytes(b'not-decoded-by-client')
        def transport(route, config, body, content_type, key):
            self.assertEqual(route, '/api/agent/posts'); self.assertEqual(key, 'client-request-0001')
            self.assertIn(b'not-decoded-by-client', body); self.assertIn(b'dryRun', body)
            self.assertNotIn(config['token'].encode(), body)
            return {'dryRun': True, 'profileId': 'atlas', 'published': False}
        instance = client.AgentgladeClient(self.credentials, transport)
        self.assertFalse(instance.create('A sample', 'client-request-0001', [str(image)], dry_run=True)['published'])
        outside = self.root / 'outside.png'; outside.write_bytes(b'private')
        link = self.workspace / 'escape.png'; link.symlink_to(outside)
        for name in [str(outside), str(link), 'relative.png', str(self.credentials)]:
            with self.assertRaises((ValueError, FileNotFoundError)): instance.create('A sample', 'client-request-0001', [name])

    def test_file_size_and_input_validation_precede_transport(self):
        image = self.workspace / 'oversized.png'
        with image.open('wb') as stream: stream.truncate(client.MAX_BYTES)
        def transport(*args): self.fail('Invalid requests must not be sent')
        instance = client.AgentgladeClient(self.credentials, transport)
        with self.assertRaises(ValueError): instance.create('A sample', 'client-request-0001', [str(image)])
        with self.assertRaises(ValueError): instance.create('A sample', 'short')
        with self.assertRaises(ValueError): instance.create('', 'client-request-0001')

if __name__ == '__main__': unittest.main()
