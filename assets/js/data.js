// Public feed reads and authenticated publishing operations.
export const SITE_ROOT = new URL('../../', import.meta.url);

export const resolve = (path) => (/^(blob:|data:|https?:)/.test(path) ? path : new URL(path, SITE_ROOT).href);

async function getJSON(path) {
  const res = await fetch(resolve(path), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

export async function loadSite() {
  return getJSON('data/site.json');
}
export const loadProfiles = async () => (await getJSON('data/profiles.json')).profiles;

export async function loadPosts() {
  const { posts } = await getJSON('data/posts.json');
  return posts.slice().sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
}

// Multipart mutations use the current human session and server-bound author.
async function communityRequest(path, options = {}) {
  let res;
  try {
    res = await fetch(resolve(path), { ...options, cache: 'no-store', credentials: 'same-origin', redirect: 'manual' });
  } catch {
    const err = new Error('No connection. Your draft is saved; try again when you are online.');
    err.code = 'OFFLINE';
    throw err;
  }
  if (res.type === 'opaqueredirect' || res.status === 401) {
    const err = new Error('Your sign-in expired.');
    err.code = 'AUTH';
    throw err;
  }
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || (res.status === 413 ? 'This post exceeds the 64 MiB upload limit. Use fewer photos or shorter videos; your draft is still here.' : `Server error ${res.status}`));
    err.code = res.status === 412 ? 'CONFLICT' : res.status === 404 ? 'NOT_FOUND' : 'REQUEST';
    throw err;
  }
  return body;
}

export const loadManagedPosts = (before = null) => communityRequest(`api/posts${before ? `?before=${encodeURIComponent(before)}` : ''}`);
export const loadEditableProfiles = () => communityRequest('api/profiles');
export const finishProfileSetup = () => communityRequest('api/me/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
export function updateProfile(id, version, { name, bio, avatar, removeAvatar }) {
  const form = new FormData(); form.set('name', name); form.set('bio', bio); form.set('removeAvatar', String(removeAvatar));
  if (avatar) form.set('avatar', avatar, avatar.name);
  return communityRequest(`api/profiles/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'If-Match': `"${version}"` }, body: form });
}
export const loadPost = (id) => communityRequest(`api/posts/${encodeURIComponent(id)}`);
export const deletePost = (post) => communityRequest(`api/posts/${encodeURIComponent(post.id)}`, {
  method: 'DELETE', headers: { 'If-Match': `"${post.version}"` },
});

async function savePost({ text, milestone, publishedAt, files, retainMedia }, { onStage, id, version } = {}) {
  const { prepareMedia } = await import('./media.js?v=8');
  onStage?.('Preparing photos…');
  const prepared = await prepareMedia(files, { onProgress: onStage });
  const fd = new FormData();
  fd.set('text', text || '');
  if (milestone) fd.set('milestone', milestone);
  fd.set('publishedAt', publishedAt);
  fd.set('mediaMeta', JSON.stringify(prepared.map(({ width, height }) => ({ width, height }))));
  if (id) fd.set('retainMedia', JSON.stringify(retainMedia || []));
  prepared.forEach(({ file }) => fd.append('media', file, file.name));

  onStage?.('Uploading and optimizing photos…');
  return communityRequest(id ? `api/posts/${encodeURIComponent(id)}` : 'api/posts', {
    method: id ? 'PUT' : 'POST', body: fd,
    ...(id ? { headers: { 'If-Match': `"${version}"` } } : {}),
  });
}

export const createPost = (post, options = {}) => savePost(post, options);
export const updatePost = (post, options) => savePost(post, options);
