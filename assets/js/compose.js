import { hydrateIcons, icon } from './icons.js?v=8';
import { getSession } from './auth.js?v=8';
import { createPost, updatePost, loadPost, loadSite, loadProfiles, resolve } from './data.js?v=8';
import { setProfileDirectory } from './profile-directory.js?v=8';
import { renderPost, esc } from './render.js?v=8';
import { loadFields, saveFields, loadMedia, saveMedia, clearDraft, loadServerDraft, saveServerDraft, uploadDraftMedia, deleteDraftMedia, deleteServerDraft, draftMediaUrl } from './drafts.js?v=8';
import { normalizeFile, preparePreview, prepareMedia } from './media.js?v=8';
import { setupCamera } from './camera.js?v=8';

const $ = (s) => document.querySelector(s);
const editId = new URLSearchParams(location.search).get('edit');
const scope = editId ? `edit:${editId}` : 'new';
const MAX_FILES = 20;
// remote: file → its copy in the account's draft; remoteOnly: placeholders for media saved from another device.
const state = { files: [], existing: [], alts: new Map(), remote: new Map(), remoteOnly: new Set(), syncOn: false, uploading: 0, dirty: false, edits: 0, editedAt: 0, syncedAt: null, describing: null, urls: new Map(), previews: new Map(), previewJobs: 0, milestoneOn: false, saving: false, ready: false, finished: false };
let session, original, site = {}, draftTimer, toastTimer;
let mediaSave = Promise.resolve(true);
let previewQueue = Promise.resolve();
let uploads = Promise.resolve(), serverTimer;
const el = {
  form: $('#composer'), fields: $('#compose-fields'), text: $('#text'), tray: $('#tray'),
  chips: $('#chips'), post: $('#post-btn'), when: $('#when'), milestone: $('#milestone'),
  milestoneRow: $('#milestone-row'), milestoneBtn: $('#toggle-milestone'),
  draft: $('#draft-status'), toast: $('#toast'), sheet: $('#preview-sheet'),
};
const localDate = (value = new Date()) => {
  const d = new Date(value);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};
const hasContent = () => !!el.text.value.trim() || state.files.length > 0 || state.existing.length > 0;
const urlFor = (file) => {
  if (state.remoteOnly.has(file)) return draftMediaUrl(scope, state.remote.get(file));
  if (!state.urls.has(file)) state.urls.set(file, URL.createObjectURL(state.previews.get(file) || file));
  return state.urls.get(file);
};
function toast(message, kind = '') {
  el.toast.textContent = message;
  el.toast.className = `toast ${kind ? `is-${kind}` : ''}`;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 6500);
}
function autosize() { el.text.style.height = 'auto'; el.text.style.height = `${el.text.scrollHeight}px`; }
function sync({ persist = true } = {}) {
  el.post.disabled = !state.ready || !session?.user || state.saving || state.previewJobs > 0 || state.finished || !hasContent();
  el.milestoneRow.hidden = !state.milestoneOn;
  el.milestoneBtn.setAttribute('aria-pressed', String(state.milestoneOn));
  const milestone = el.milestone.value.trim();
  el.chips.innerHTML = state.milestoneOn && milestone
    ? `<span class="tag">${icon('flag')}${esc(milestone)}<button type="button" class="chip-remove" data-clear-milestone aria-label="Remove milestone">${icon('x')}</button></span>` : '';
  if (persist) persistDraft();
}
function setBusy(busy) {
  state.saving = busy;
  el.fields.disabled = busy || !state.ready;
  el.form.setAttribute('aria-busy', String(busy));
  el.post.textContent = busy ? (editId ? 'Saving…' : 'Posting…') : (editId ? 'Save changes' : 'Post');
  sync({ persist: false });
}
function fields() {
  return { text: el.text.value, milestone: el.milestone.value, milestoneOn: state.milestoneOn,
    when: el.when.value, retained: state.existing.map((m) => ({ src: m.src, alt: m.alt || '' })), version: original?.version };
}
function persistDraft() {
  clearTimeout(draftTimer);
  if (!state.ready || state.saving || state.finished) return;
  state.dirty = true; state.edits++; state.editedAt = Date.now();
  if (state.syncOn) el.draft.textContent = 'Saving draft to your account…';
  draftTimer = setTimeout(() => {
    const saved = saveFields(fields(), scope, { dirty: true, editedAt: state.editedAt });
    if (!state.syncOn) el.draft.textContent = saved ? 'Draft saved on this device' : 'This device could not save your draft.';
    scheduleServerSave();
  }, 400);
}
/* ---- The copy of the draft saved to the member's account ---- */
function scheduleServerSave() {
  clearTimeout(serverTimer);
  if (!state.syncOn || !state.ready || state.saving || state.finished) return;
  el.draft.textContent = 'Saving draft to your account…';
  serverTimer = setTimeout(saveToServer, 1200);
}
async function saveToServer() {
  clearTimeout(serverTimer);
  if (!state.syncOn || state.finished) return;
  const media = state.files.filter((file) => state.remote.has(file)).map((file) => ({ id: state.remote.get(file), alt: state.alts.get(file) || '' }));
  const edits = state.edits;
  try {
    const saved = await saveServerDraft(scope, { fields: fields(), media });
    // Clean only if nothing changed while saving; otherwise the next save carries it.
    state.syncedAt = saved.updatedAt;
    if (edits === state.edits && !state.finished) { state.dirty = false; saveFields(fields(), scope, { dirty: false, syncedAt: saved.updatedAt, editedAt: state.editedAt }); }
    if (!state.uploading) el.draft.textContent = 'Draft saved to your account';
  } catch { el.draft.textContent = 'Draft saved on this device. It syncs to your account when you are back online.'; }
}
// Photos are prepared and saved to the account as they are added, one at a time.
function queueUpload(file) {
  if (!state.syncOn || state.remote.has(file) || !state.files.includes(file)) return uploads;
  state.uploading++;
  el.draft.textContent = 'Saving photos to your account…';
  uploads = uploads.then(async () => {
    if (!state.files.includes(file) || state.remote.has(file) || state.finished) return;
    const [prepared] = await prepareMedia([file]);
    const { id } = await uploadDraftMedia(scope, prepared.file);
    if (!state.files.includes(file)) { deleteDraftMedia(scope, id); return; }
    state.remote.set(file, id);
    persistMedia();
  }).catch((error) => { toast(`${file.name} is saved on this device only: ${error.message}`, 'error'); })
    .finally(() => { state.uploading--; if (!state.uploading) saveToServer(); });
  return uploads;
}
function persistMedia() {
  const snapshot = state.files.map((file) => ({ file, alt: state.alts.get(file) || '', remoteId: state.remote.get(file) || null, remoteOnly: state.remoteOnly.has(file) }));
  mediaSave = mediaSave.then(() => saveMedia(snapshot, scope));
  mediaSave.then((ok) => { if (!ok) toast('This device could not save draft photos. Keep this page open until you post.', 'error'); });
}
function queuePreviews(files) {
  for (const file of files) if (state.remoteOnly.has(file)) state.previews.set(file, 'remote');
  for (const file of files.filter((item) => item.type.startsWith('image/') && !state.remoteOnly.has(item))) {
    state.previewJobs++;
    previewQueue = previewQueue.then(async () => {
      try {
        if (state.files.includes(file)) state.previews.set(file, await preparePreview(file));
      } catch { state.previews.set(file, null); }
      finally {
        state.previewJobs--;
        if (!state.files.includes(file)) state.previews.delete(file);
        renderTray(); sync({ persist: false });
        $('#preview-status').hidden = state.previewJobs === 0;
      }
    });
  }
  $('#preview-status').hidden = state.previewJobs === 0;
  sync({ persist: false });
}
function renderTray() {
  const items = [
    ...state.existing.map((media, i) => ({ video: media.type === 'video' && !media.status, src: resolve(media.previewSrc || media.src), remove: `data-remove-existing="${i}"`,
      note: media.status && (media.status === 'failed' ? 'Could not be processed' : 'Processing…'), poster: media.posterSrc && resolve(media.posterSrc),
      alt: media.alt, describe: `data-describe-existing="${i}"` })),
    ...state.files.map((file, i) => ({ video: file.type.startsWith('video/'),
      src: file.type.startsWith('video/') || state.previews.get(file) ? urlFor(file) : null,
      pending: !state.previews.has(file), remove: `data-remove="${i}"`, alt: state.alts.get(file), describe: `data-describe="${i}"` })),
  ];
  const cells = items.map((item, i) => `<li>
    ${item.note ? `<span class="tray-file-label">Video ${i + 1}<br>${item.note}</span>` : item.video ? `<video src="${esc(item.src)}"${item.poster ? ` poster="${esc(item.poster)}" preload="none"` : ' preload="metadata"'} muted playsinline></video><span class="media-play">${icon('play')}</span>` : item.src ? `<img src="${esc(item.src)}" alt="Photo ${i + 1}" data-photo-preview><span class="tray-file-label" hidden>Photo ${i + 1}<br>Preview after posting</span>` : `<span class="tray-file-label">Photo ${i + 1}<br>${item.pending ? 'Preparing preview…' : 'Preview after posting'}</span>`}
    <span class="tray-index">${i + 1}</span>
    ${item.video || item.note ? '' : `<button type="button" class="tray-alt" ${item.describe} data-described="${!!item.alt}" aria-label="${item.alt ? `Edit the description of photo ${i + 1}` : `Describe photo ${i + 1} for people who can’t see it`}">ALT</button>`}
    <button type="button" class="icon-button tray-remove" ${item.remove} aria-label="Remove ${item.video ? 'video' : 'photo'} ${i + 1}">${icon('x')}</button>
  </li>`);
  if (items.length && items.length < MAX_FILES) cells.push(`<li class="add-cell"><label class="tray-add">${icon('plus', 'icon icon-lg')}Add more<input class="sr-only" type="file" accept="image/*,video/*" multiple></label></li>`);
  el.tray.innerHTML = cells.join('');
  el.tray.querySelectorAll('[data-photo-preview]').forEach((image) => image.addEventListener('error', () => {
    image.hidden = true;
    image.nextElementSibling.hidden = false;
  }));
}
async function restoreDraft() {
  // Which copy wins: a clean copy here (no unsaved edits) follows the account, and is
  // dropped once the draft was posted or discarded elsewhere. Unsaved edits here win
  // unless the account also changed since this device last synced; then the newer does.
  let local = loadFields(scope), localMedia = await loadMedia(scope);
  let server = null, finished = false;
  if (session?.user) {
    try { const found = await loadServerDraft(scope); finished = !!found?.finishedAt; server = finished ? null : found; state.syncOn = true; } catch { state.syncOn = false; }
  }
  const useServer = !!server && (!local.dirty || (local.syncedAt !== server.updatedAt && !(local.savedAt > Date.parse(server.updatedAt))));
  if (finished && !local.dirty) { await clearDraft(scope); local = {}; localMedia = []; }
  state.dirty = !useServer && !!local.dirty;
  state.syncedAt = useServer ? server.updatedAt : local.syncedAt || null;
  state.editedAt = useServer ? Date.parse(server.updatedAt) : local.savedAt || 0;
  const draft = useServer ? server.fields : local;
  const restored = Object.hasOwn(draft, 'text');
  el.text.value = restored ? draft.text : original?.text || '';
  el.milestone.value = restored ? draft.milestone || '' : original?.milestone || '';
  state.milestoneOn = restored ? !!draft.milestoneOn : !!original?.milestone;
  el.when.value = (restored && draft.when) || localDate(original?.publishedAt);
  state.existing = [...(original?.media || [])];
  if (restored && Array.isArray(draft.retained)) {
    // Drafts list kept photos as { src, alt }; older drafts list only src.
    const kept = new Map(draft.retained.map((entry) => typeof entry === 'string' ? [entry, undefined] : [entry?.src, entry?.alt]));
    state.existing = state.existing.filter((m) => kept.has(m.src)).map((m) => typeof kept.get(m.src) === 'string' ? { ...m, alt: kept.get(m.src) } : m);
  }
  if (restored && original && draft.version) original.version = draft.version;
  if (useServer) {
    // Reuse media this device already holds; show the rest straight from the account.
    const held = new Map(localMedia.filter((m) => m.remoteId && !m.remoteOnly).map((m) => [m.remoteId, m.file]));
    state.files = server.media.map((m) => {
      const file = held.get(m.id) || new File([], m.name, { type: m.type });
      if (!held.has(m.id)) state.remoteOnly.add(file);
      state.remote.set(file, m.id);
      if (m.alt) state.alts.set(file, m.alt);
      return file;
    });
    saveFields(draft, scope, { dirty: false, syncedAt: server.updatedAt, editedAt: state.editedAt });
    persistMedia();
  } else {
    state.files = localMedia.map(({ file, alt, remoteId, remoteOnly }) => {
      if (remoteId) state.remote.set(file, remoteId);
      if (remoteOnly) state.remoteOnly.add(file);
      if (alt) state.alts.set(file, alt);
      return file;
    });
  }
  queuePreviews(state.files);
  renderTray(); autosize(); sync({ persist: false });
  if (useServer) el.draft.textContent = 'Draft restored from your account';
  else if (restored || state.files.length) el.draft.textContent = 'Draft restored on this device';
  // This device has unsaved edits: bring the account's copy up to date.
  if (state.syncOn && state.dirty && (restored || state.files.length)) { state.files.forEach(queueUpload); if (!state.uploading) saveToServer(); }
}
function addFiles(files) {
  if (state.saving) return;
  const incoming = [];
  for (const file of files) {
    try { incoming.push(normalizeFile(file)); }
    catch (error) { toast(error.message, 'error'); }
  }
  const room = MAX_FILES - state.files.length - state.existing.length;
  if (incoming.length > room) toast(`Up to ${MAX_FILES} photos and videos per post.`, 'error');
  const added = incoming.slice(0, Math.max(0, room));
  state.files.push(...added);
  queuePreviews(added);
  renderTray(); persistMedia(); sync();
  added.forEach(queueUpload);
}
// Photo descriptions (alt text) for people using screen readers or when a photo cannot load.
function openDescription(target) {
  if (state.saving) return;
  const media = target.file ? null : state.existing[target.index];
  if (!target.file && !media) return;
  state.describing = target;
  const src = target.file ? (state.previews.get(target.file) ? urlFor(target.file) : null) : resolve(media.previewSrc || media.src);
  $('#alt-preview').hidden = !src;
  if (src) $('#alt-preview').src = src; else $('#alt-preview').removeAttribute('src');
  $('#alt-text').value = target.file ? state.alts.get(target.file) || '' : media.alt || '';
  $('#alt-count').textContent = $('#alt-text').value.length;
  $('#alt-dialog').showModal();
  $('#alt-text').focus();
}
function saveDescription(event) {
  event.preventDefault();
  const target = state.describing, alt = $('#alt-text').value.trim().slice(0, 300);
  if (target?.file && state.files.includes(target.file)) {
    if (alt) state.alts.set(target.file, alt); else state.alts.delete(target.file);
    persistMedia();
  } else if (target && state.existing[target.index]) {
    state.existing[target.index] = { ...state.existing[target.index], alt };
  }
  $('#alt-dialog').close();
  renderTray(); sync();
}
function draftPost() {
  const author = original?.author || session?.name || 'Community';
  return { id: 'preview', author, initials: original?.initials,
    publishedAt: original && el.when.value === localDate(original.publishedAt)
      ? original.publishedAt : new Date(el.when.value || Date.now()).toISOString(),
    milestone: state.milestoneOn ? el.milestone.value.trim() || null : null,
    text: el.text.value.trim(), media: [...state.existing, ...state.files.map((file) => ({
      type: file.type.startsWith('video/') ? 'video' : 'image',
      src: file.type.startsWith('video/') || state.previews.get(file) ? urlFor(file) : '',
      pendingPreview: file.type.startsWith('image/') && !state.previews.get(file), alt: state.alts.get(file) || '',
    }))] };
}
function preview() {
  try {
    $('#preview-body').innerHTML = hasContent() ? renderPost(draftPost(), { born: site.born, preview: true })
      : '<p class="feed-status">Write something or add a photo to see the preview.</p>';
    el.sheet.showModal();
  } catch { toast('Choose a valid post date before previewing.', 'error'); }
}
async function submit(event) {
  event.preventDefault();
  if (state.saving || state.previewJobs > 0 || !state.ready || !session?.user || !hasContent()) return;
  clearTimeout(draftTimer);
  saveFields(fields(), scope, { dirty: state.dirty, editedAt: state.editedAt });
  setBusy(true);
  $('#upload-status').hidden = false;
  try {
    await mediaSave;
    // Post by reference when every photo is in the account's draft; else upload them now.
    let draftMedia = null;
    if (state.syncOn) {
      state.files.forEach(queueUpload);
      await uploads;
      if (state.files.every((file) => state.remote.has(file))) draftMedia = state.files.map((file) => ({ id: state.remote.get(file), alt: state.alts.get(file) || '' }));
    }
    if (!draftMedia && state.files.some((file) => state.remoteOnly.has(file))) throw new Error('Some photos in this draft are saved only in your account. Reconnect and try again.');
    const post = draftPost();
    const input = { text: post.text, milestone: post.milestone, publishedAt: post.publishedAt,
      files: draftMedia ? [] : [...state.files], alts: state.files.map((file) => state.alts.get(file) || ''),
      draft: draftMedia && { scope, media: draftMedia },
      retainMedia: state.existing.map((m) => ({ src: m.src, alt: m.alt || '' })) };
    const options = { onStage: (message) => { $('#upload-status').textContent = message; }, ...(editId ? { id: editId, version: original.version } : {}) };
    const saved = await (editId ? updatePost(input, options) : createPost(input, options));
    state.finished = true;
    clearTimeout(draftTimer); clearTimeout(serverTimer);
    await clearDraft(scope);
    if (state.syncOn) await deleteServerDraft(scope);
    toast(editId ? 'Changes saved to the community feed.' : 'Posted to the community feed.', 'success');
    setTimeout(() => location.assign(`../manage/?saved=${encodeURIComponent(saved.id)}`), 600);
  } catch (error) {
    $('#upload-status').textContent = error.message;
    if (error.code === 'AUTH') {
      toast('Your sign-in expired. Your draft is saved; signing you back in…', 'error');
      setTimeout(() => location.reload(), 1800);
    } else {
      toast(error.code === 'CONFLICT' ? `${error.message} Your draft is still here.` : `Couldn't save: ${error.message}`, 'error');
      setBusy(false);
    }
  }
}
function trackKeyboard() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const update = () => {
    const height = Math.max(0, innerHeight - viewport.height - viewport.offsetTop);
    document.body.style.setProperty('--kb', `${height}px`);
    document.body.classList.toggle('kb-open', height > 80);
  };
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
}
async function init() {
  hydrateIcons();
  setProfileDirectory(await loadProfiles().catch(() => []));
  if (editId) {
    document.title = 'Edit post · Agentglade';
    $('#compose-title').textContent = 'Edit post';
    el.post.textContent = 'Save changes';
    $('#nav-new').removeAttribute('aria-current');
    $('#nav-manage').setAttribute('aria-current', 'page');
    $('#discard-edits').hidden = false;
  }
  session = await getSession();
  $('#me-name').textContent = session?.name || 'Not signed in';
  $('#me-initials').textContent = (session?.name || '?').split(/[\s@._-]+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  if (!session) toast('You are offline or signed out. New drafts can still save on this device.', 'error');
  if (editId) {
    try {
      original = await loadPost(editId);
      if (original.canEdit === false) throw new Error('You can only edit your own posts. Choose one from Past posts.');
      $('#edit-context').textContent = `Editing a post by ${original.author}. Your changes appear on the public feed after saving.`;
      $('#edit-context').hidden = false;
    } catch (error) {
      $('#edit-error').textContent = error.code === 'NOT_FOUND' ? 'This post no longer exists. Open Past posts to choose another.' : error.message;
      $('#edit-error').hidden = false;
      return;
    }
  }
  state.ready = true;
  await restoreDraft();
  setBusy(false);
  el.text.addEventListener('input', () => { autosize(); sync(); });
  el.milestone.addEventListener('input', () => sync());
  el.when.addEventListener('change', () => sync());
  el.form.addEventListener('submit', submit);
  el.form.addEventListener('change', (event) => {
    if (event.target.matches('input[type="file"]')) { addFiles(event.target.files); event.target.value = ''; }
  });
  el.form.addEventListener('click', (event) => {
    if (state.saving) return;
    const remove = event.target.closest('[data-remove]');
    const existing = event.target.closest('[data-remove-existing]');
    if (remove) {
      const [file] = state.files.splice(Number(remove.dataset.remove), 1);
      state.previews.delete(file); state.alts.delete(file);
      if (state.remote.has(file)) { deleteDraftMedia(scope, state.remote.get(file)); state.remote.delete(file); }
      state.remoteOnly.delete(file);
      if (state.urls.has(file)) { URL.revokeObjectURL(state.urls.get(file)); state.urls.delete(file); }
      renderTray(); persistMedia(); sync();
    }
    if (existing) { state.existing.splice(Number(existing.dataset.removeExisting), 1); renderTray(); sync(); }
    const describeNew = event.target.closest('[data-describe]'), describeExisting = event.target.closest('[data-describe-existing]');
    if (describeNew) openDescription({ file: state.files[Number(describeNew.dataset.describe)] });
    if (describeExisting) openDescription({ index: Number(describeExisting.dataset.describeExisting) });
    if (event.target.closest('[data-clear-milestone]')) { state.milestoneOn = false; el.milestone.value = ''; sync(); }
  });
  el.milestoneBtn.addEventListener('click', () => {
    state.milestoneOn = !state.milestoneOn; sync();
    if (state.milestoneOn) el.milestone.focus();
  });
  $('#open-preview').addEventListener('click', preview);
  $('#alt-form').addEventListener('submit', saveDescription);
  $('#alt-text').addEventListener('input', () => { $('#alt-count').textContent = $('#alt-text').value.length; });
  $('#alt-dialog').addEventListener('click', (event) => { if (event.target === $('#alt-dialog') || event.target.closest('[data-close]')) $('#alt-dialog').close(); });
  $('#alt-dialog').addEventListener('close', () => { state.describing = null; });
  setupCamera({ addFiles, canAdd: () => !state.saving && state.files.length + state.existing.length < MAX_FILES });
  el.sheet.addEventListener('click', (event) => { if (event.target === el.sheet || event.target.closest('[data-close]')) el.sheet.close(); });
  $('#discard-edits').addEventListener('click', async () => {
    if (!confirm('Discard your local edits and reload the saved post?')) return;
    clearTimeout(draftTimer); clearTimeout(serverTimer);
    state.finished = true;
    await mediaSave;
    await clearDraft(scope);
    if (state.syncOn) await deleteServerDraft(scope);
    location.reload();
  });
  document.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files || [])];
    if (files.length && !state.saving) { event.preventDefault(); addFiles(files); }
  });
  addEventListener('pagehide', () => { if (state.ready && !state.saving && !state.finished) saveFields(fields(), scope, { dirty: state.dirty, editedAt: state.editedAt }); });
  // Back on this device after editing elsewhere: a clean copy reloads the account's newer one.
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden || !state.syncOn || state.dirty || state.saving || state.finished || state.uploading) return;
    try {
      const found = await loadServerDraft(scope);
      if (!state.dirty && (found?.finishedAt || (found?.updatedAt && found.updatedAt !== state.syncedAt))) location.reload();
    } catch { /* Offline: keep what is here. */ }
  });
  // Back online: unsaved edits and photos on this device sync to the account.
  addEventListener('online', () => {
    if (!session?.user || state.finished) return;
    state.syncOn = true;
    state.files.forEach(queueUpload);
    if (state.dirty && !state.uploading) saveToServer();
  });
  trackKeyboard();
  loadSite().then((value) => {
    site = value;
    if (value.signOutUrl) { $('#sign-out').href = value.signOutUrl; $('#sign-out').hidden = false; }
  }).catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
