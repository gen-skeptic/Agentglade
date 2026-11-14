// Draft storage on this device: text fields in localStorage, media blobs in
// IndexedDB, so a draft survives the phone killing the app mid-post.
const KEY = 'agentglade.draft';
const DB = 'agentglade-drafts';
const STORE = 'media';

const fieldKey = (scope) => scope === 'new' ? KEY : `${KEY}.${scope}`;
const mediaKey = (scope) => scope === 'new' ? 'current' : scope;

export function loadFields(scope = 'new') {
  try { return JSON.parse(localStorage.getItem(fieldKey(scope))) || {}; } catch { return {}; }
}
export function saveFields(fields, scope = 'new') {
  try { localStorage.setItem(fieldKey(scope), JSON.stringify(fields)); return true; } catch { return false; }
}

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// items: [{ file, alt }]. Descriptions are kept with the draft photos.
export async function saveMedia(items, scope = 'new') {
  let d;
  try {
    d = await db();
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(items.map(({ file, alt = '' }) => ({ blob: file, name: file.name, type: file.type, alt })), mediaKey(scope));
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
    return rows.map((x) => ({ file: new File([x.blob], x.name, { type: x.type }), alt: typeof x.alt === 'string' ? x.alt : '' }));
  } catch { return []; }
  finally { d?.close(); }
}

export async function clearDraft(scope = 'new') {
  try { localStorage.removeItem(fieldKey(scope)); } catch {}
  await saveMedia([], scope);
}
