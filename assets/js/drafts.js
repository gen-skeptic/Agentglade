// Drafts are kept on this device (text in localStorage, media in IndexedDB), so a
// draft survives the phone closing the app or losing its connection, and synced to
// the member's account, so it can be finished on another device.
import { resolve } from './data.js?v=8';

const KEY = 'agentglade.draft';
const DB = 'agentglade-drafts';
const STORE = 'media';

const fieldKey = (scope) => scope === 'new' ? KEY : `${KEY}.${scope}`;
const mediaKey = (scope) => scope === 'new' ? 'current' : scope;

export function loadFields(scope = 'new') {
  try { return JSON.parse(localStorage.getItem(fieldKey(scope))) || {}; } catch { return {}; }
}
// dirty: this device has edits the account has not saved yet. syncedAt: the account's
// version this copy last matched. Together they decide which copy wins on another
// visit without trusting device clocks; editedAt (stored as savedAt) breaks the rare
// tie when both copies changed. It is the time of the last edit, not of this write.
export function saveFields(fields, scope = 'new', { dirty = true, syncedAt, editedAt } = {}) {
  try {
    const previous = loadFields(scope);
    localStorage.setItem(fieldKey(scope), JSON.stringify({ ...fields, savedAt: editedAt ?? previous.savedAt ?? Date.now(), dirty,
      syncedAt: syncedAt === undefined ? previous.syncedAt ?? null : syncedAt }));
    return true;
  } catch { return false; }
}

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// items: [{ file, alt, remoteId, remoteOnly }]. remoteId names the copy saved to the
// account; remoteOnly marks a placeholder for media this device never had.
export async function saveMedia(items, scope = 'new') {
  let d;
  try {
    d = await db();
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(items.map(({ file, alt = '', remoteId = null, remoteOnly = false }) => ({ blob: file, name: file.name, type: file.type, alt, remoteId, remoteOnly })), mediaKey(scope));
    await new Promise((r, j) => { tx.oncomplete = r; tx.onerror = () => j(tx.error); });
    return true;
  } catch (e) { console.warn('Draft media not saved', e); return false; }
  finally { d?.close(); }
}

export async function loadMedia(scope = 'new') {
  let d;
  try {
    d = await db();
    const req = d.transaction(STORE).objectStore(STORE).get(mediaKey(scope));
    const rows = await new Promise((r, j) => { req.onsuccess = () => r(req.result || []); req.onerror = () => j(req.error); });
    return rows.map((x) => ({ file: new File([x.blob], x.name, { type: x.type }), alt: typeof x.alt === 'string' ? x.alt : '', remoteId: x.remoteId || null, remoteOnly: !!x.remoteOnly }));
  } catch { return []; }
  finally { d?.close(); }
}

/* ---- The copy saved to the member's account ---- */
const api = (path, options = {}) => fetch(resolve(path), { cache: 'no-store', credentials: 'same-origin', redirect: 'manual', ...options });
const scoped = (path, scope) => `${path}?scope=${encodeURIComponent(scope)}`;
async function failure(res) { return new Error((await res.json().catch(() => ({}))).error || `Server error ${res.status}`); }
export async function loadServerDraft(scope) {
  const res = await api(scoped('api/drafts', scope));
  if (!res.ok) throw await failure(res);
  // No fields means no draft; finishedAt says it was posted or discarded on some device.
  const draft = await res.json();
  return draft.fields ? draft : draft.finishedAt ? { finishedAt: draft.finishedAt } : null;
}
export async function saveServerDraft(scope, draft) {
  const res = await api(scoped('api/drafts', scope), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
  if (!res.ok) throw await failure(res);
  return res.json();
}
export async function uploadDraftMedia(scope, file) {
  const body = new FormData(); body.set('media', file, file.name);
  const res = await api(scoped('api/drafts/media', scope), { method: 'POST', body });
  if (!res.ok) throw await failure(res);
  return res.json();
}
export const deleteDraftMedia = (scope, id) => api(scoped(`api/drafts/media/${id}`, scope), { method: 'DELETE' }).catch(() => {});
export const deleteServerDraft = (scope) => api(scoped('api/drafts', scope), { method: 'DELETE' }).catch(() => {});
export const draftMediaUrl = (scope, id) => resolve(scoped(`api/drafts/media/${id}`, scope));

export async function clearDraft(scope = 'new') {
  try { localStorage.removeItem(fieldKey(scope)); } catch {}
  await saveMedia([], scope);
}
