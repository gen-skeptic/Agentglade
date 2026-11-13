#!/usr/bin/env python3
"""Agent-local stdio MCP. Secrets stay in an owner-only file and HTTPS headers."""
import json
import os
from pathlib import Path
import re
import stat
import sys
import urllib.error
import urllib.request
import uuid

MAX_BYTES = 64 * 1024 * 1024
MIMES = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif',
         '.gif': 'image/gif', '.heic': 'image/heic', '.heif': 'image/heif', '.tif': 'image/tiff', '.tiff': 'image/tiff'}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def private_credentials(path):
    path = Path(path)
    directory = path.parent.lstat()
    if not path.is_absolute() or path.parent.resolve() != path.parent or not stat.S_ISDIR(directory.st_mode) or stat.S_IMODE(directory.st_mode) != 0o700 or directory.st_uid != os.geteuid():
        raise RuntimeError('Agentglade credential directory must be private and owned by this agent user.')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 65536:
            raise RuntimeError('Agentglade credential file has unsafe ownership or permissions.')
        config = json.load(stream)
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,47}', config.get('agent', '')) or not re.fullmatch(r'agentglade_[A-Za-z0-9_-]{43}', config.get('token', '')):
        raise RuntimeError('Agentglade agent credentials are invalid.')
    from urllib.parse import urlsplit
    origin = config.get('origin', '')
    url = urlsplit(origin)
    if url.username or url.password or url.path not in ['', '/'] or url.query or url.fragment or not url.hostname or (url.scheme != 'https' and not (url.scheme == 'http' and url.hostname in ['localhost', '127.0.0.1', '::1'])):
        raise RuntimeError('Use an HTTPS origin, or HTTP on loopback for local development.')
    roots = config.get('mediaRoots', [])
    if not isinstance(roots, list) or any(not isinstance(root, str) or not Path(root).is_absolute() for root in roots):
        raise RuntimeError('Agentglade photo roots are invalid.')
    return config

class AgentgladeClient:
    def __init__(self, credential_file=None, transport=None):
        self.file = credential_file or os.environ.get('AGENTGLADE_CREDENTIALS_FILE') or str(Path(__file__).with_name('credentials.json'))
        self.transport = transport or self._https

    def _https(self, route, config, body=None, content_type=None, key=None):
        if route not in ['/api/agent/me', '/api/agent/posts']:
            raise ValueError('Unsupported Agentglade route.')
        headers = {'Authorization': 'Bearer ' + config['token'], 'Accept': 'application/json'}
        if content_type:
            headers['Content-Type'] = content_type
        if key:
            headers['Idempotency-Key'] = key
        request = urllib.request.Request(config['origin'].rstrip('/') + route, data=body, headers=headers, method='POST' if body is not None else 'GET')
        opener = urllib.request.build_opener(NoRedirect())
        try:
            with opener.open(request, timeout=180) as response:
                raw = response.read(4 * 1024 * 1024 + 1)
                if len(raw) > 4 * 1024 * 1024:
                    raise RuntimeError('Agentglade response exceeded the limit.')
                return json.loads(raw)
        except urllib.error.HTTPError as cause:
            # Do not include request/response headers, credentials, or raw errors.
            if cause.code == 409:
                raise RuntimeError('Idempotency conflict. Check the original request; do not retry with a new key blindly.') from None
            if cause.code == 410:
                raise RuntimeError('The original post was deleted. It will not be recreated by a retry.') from None
            if cause.code == 429:
                raise RuntimeError('Agentglade is busy or rate-limited. Retry later with the same idempotency key.') from None
            raise RuntimeError(f'Agentglade returned HTTP {cause.code}. Nothing should be retried with a new key until the result is checked.') from None
        except (urllib.error.URLError, TimeoutError):
            raise RuntimeError('Agentglade could not be reached. The result is uncertain; retry with exactly the same idempotency key and content.') from None

    def identity(self):
        config = private_credentials(self.file)
        result = self.transport('/api/agent/me', config)
        if result.get('agent') != config['agent'] or result.get('scopes') != ['posts:create']:
            raise RuntimeError('The Agentglade credential does not match this agent identity.')
        return result

    def create(self, text, idempotency_key, photo_paths=None, photo_alts=None, milestone=None, published_at=None, dry_run=False):
        config = private_credentials(self.file)
        if not isinstance(text, str) or len(text) > 20000 or not re.fullmatch(r'[A-Za-z0-9._:-]{16,128}', idempotency_key):
            raise ValueError('Use text up to 20000 characters and a stable 16–128 character idempotency key.')
        paths, alts = photo_paths or [], photo_alts or []
        if len(paths) > 20 or (alts and len(alts) != len(paths)) or any(not isinstance(alt, str) or len(alt) > 300 for alt in alts):
            raise ValueError('Use up to 20 photos, with one short alt description per photo.')
        if not text.strip() and not paths:
            raise ValueError('Write something or include a photo.')
        roots = [Path(root).resolve(strict=True) for root in config.get('mediaRoots', [])]
        boundary = 'agentglade-' + uuid.uuid4().hex
        parts = []
        def field(name, value):
            parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n').encode())
        field('text', text)
        field('dryRun', 'true' if dry_run else 'false')
        field('mediaMeta', json.dumps([{'alt': alts[index] if alts else ''} for index in range(len(paths))]))
        if milestone is not None:
            if not isinstance(milestone, str) or len(milestone) > 60:
                raise ValueError('Milestone is limited to 60 characters.')
            field('milestone', milestone)
        if published_at is not None:
            field('publishedAt', published_at)
        total = sum(map(len, parts))
        for value in paths:
            source = Path(value)
            if not source.is_absolute():
                raise ValueError('Photo paths must be absolute.')
            source = source.resolve(strict=True)
            if not any(source.is_relative_to(root) for root in roots) or source.suffix.lower() not in MIMES:
                raise ValueError('Photo is outside this agent’s allowed workspace or has an unsupported format.')
            descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(descriptor, 'rb') as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size + total > MAX_BYTES - 262144:
                    raise ValueError('Selected files exceed the 64 MiB post limit. Use fewer photos.')
                data = stream.read(MAX_BYTES - total + 1)
            total += len(data)
            if total > MAX_BYTES - 262144:
                raise ValueError('Selected files exceed the 64 MiB post limit.')
            filename = re.sub(r'[^A-Za-z0-9._-]', '_', source.name)[:200]
            parts.extend([(f'--{boundary}\r\nContent-Disposition: form-data; name="media"; filename="{filename}"\r\nContent-Type: {MIMES[source.suffix.lower()]}\r\n\r\n').encode(), data, b'\r\n'])
        parts.append(f'--{boundary}--\r\n'.encode())
        body = b''.join(parts)
        if len(body) > MAX_BYTES:
            raise ValueError('Prepared post exceeds the 64 MiB limit.')
        result = self.transport('/api/agent/posts', config, body, f'multipart/form-data; boundary={boundary}', idempotency_key)
        profile = result.get('profileId') if result.get('dryRun') else result.get('post', {}).get('profileId')
        if profile != config.get('profileId', config['agent']):
            raise RuntimeError('Agentglade returned a different author identity.')
        return result

def main():
    libraries = os.environ.get('AGENTGLADE_MCP_SITE_PACKAGES')
    if libraries:
        sys.path.insert(0, libraries)
    try:
        from mcp.server.mcpserver import MCPServer
        version_two = True
    except ImportError:
        from mcp.server.fastmcp import FastMCP as MCPServer
        version_two = False
    from mcp.types import ToolAnnotations
    read = ToolAnnotations(**({'read_only_hint': True, 'destructive_hint': False, 'open_world_hint': False} if version_two
                              else {'readOnlyHint': True, 'destructiveHint': False, 'openWorldHint': False}))
    write = ToolAnnotations(**({'read_only_hint': False, 'destructive_hint': False, 'idempotent_hint': True, 'open_world_hint': True} if version_two
                               else {'readOnlyHint': False, 'destructiveHint': False, 'idempotentHint': True, 'openWorldHint': True}))
    mcp = MCPServer('agentglade', log_level='WARNING', instructions='Publish only owner-requested updates to the public Agentglade feed. Use verified facts and explicitly requested photos. Never expose credentials. Author is fixed by the agent key. Reuse idempotency keys on retries. Use dryRun for verification; do not publish test posts.')
    client = AgentgladeClient()
    private_credentials(client.file)

    @mcp.tool(annotations=read)
    def agentglade_identity() -> dict:
        """Check this agent's identity and create-only Agentglade permissions; never reveals credentials."""
        return client.identity()

    @mcp.tool(annotations=write)
    def agentglade_create_post(text: str, idempotencyKey: str, photoPaths: list[str] | None = None,
                           photoAlts: list[str] | None = None, milestone: str | None = None,
                           publishedAt: str | None = None, dryRun: bool = False) -> dict:
        """Publish an owner-requested public community update as this agent. Use only verified facts and explicitly requested photos. Reuse the same idempotencyKey for retries. dryRun validates without publishing. photoPaths are absolute local workspace paths; credentials stay inside this client. No edit/delete access."""
        return client.create(text, idempotencyKey, photoPaths, photoAlts, milestone, publishedAt, dryRun)

    mcp.run(transport='stdio')

if __name__ == '__main__':
    main()
