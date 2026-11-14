import { hydrateIcons, icon } from './icons.js?v=8';
import { getSession } from './auth.js?v=8';
import { createPost, updatePost, loadPost, loadSite, loadProfiles, resolve } from './data.js?v=8';
import { setProfileDirectory } from './profile-directory.js?v=8';
import { renderPost, esc } from './render.js?v=8';
import { loadFields, saveFields, loadMedia, saveMedia, clearDraft } from './drafts.js?v=8';
import { normalizeFile, preparePreview } from './media.js?v=8';
import { setupCamera } from './camera.js?v=8';

const $ = (s) => document.querySelector(s);
const editId = new URLSearchParams(location.search).get('edit');
const scope = editId ? `edit:${editId}` : 'new';
const MAX_FILES = 20;
const state = { files: [], existing: [], alts: new Map(), describing: null, urls: new Map(), previews: new Map(), previewJobs: 0, milestoneOn: false, saving: false, ready: false, finished: false };
let session, original, site = {}, draftTimer, toastTimer;
let mediaSave = Promise.resolve(true);
let previewQueue = Promise.resolve();
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
  draftTimer = setTimeout(() => {
    const saved = saveFields(fields(), scope);
    el.draft.textContent = saved ? 'Draft saved on this device' : 'This device could not save your draft.';
  }, 400);
}
function persistMedia() {
  const snapshot = state.files.map((file) => ({ file, alt: state.alts.get(file) || '' }));
  mediaSave = mediaSave.then(() => saveMedia(snapshot, scope));
  mediaSave.then((ok) => { if (!ok) toast('This device could not save draft photos. Keep this page open until you post.', 'error'); });
}
function queuePreviews(files) {
  for (const file of files.filter((item) => item.type.startsWith('image/'))) {
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
  const draft = loadFields(scope);
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
  const saved = await loadMedia(scope);
  state.files = saved.map(({ file }) => file);
  for (const { file, alt } of saved) if (alt) state.alts.set(file, alt);
  queuePreviews(state.files);
  renderTray(); autosize(); sync({ persist: false });
  if (restored || state.files.length) el.draft.textContent = 'Draft restored on this device';
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
  saveFields(fields(), scope);
  setBusy(true);
  $('#upload-status').hidden = false;
  try {
    await mediaSave;
    const post = draftPost();
    const input = { text: post.text, milestone: post.milestone, publishedAt: post.publishedAt,
      files: [...state.files], alts: state.files.map((file) => state.alts.get(file) || ''),
      retainMedia: state.existing.map((m) => ({ src: m.src, alt: m.alt || '' })) };
    const options = { onStage: (message) => { $('#upload-status').textContent = message; }, ...(editId ? { id: editId, version: original.version } : {}) };
    const saved = await (editId ? updatePost(input, options) : createPost(input, options));
    state.finished = true;
    clearTimeout(draftTimer);
    await clearDraft(scope);
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
    clearTimeout(draftTimer);
    await mediaSave;
    await clearDraft(scope);
    state.finished = true;
    location.reload();
  });
  document.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files || [])];
    if (files.length && !state.saving) { event.preventDefault(); addFiles(files); }
  });
  addEventListener('pagehide', () => { if (state.ready && !state.saving && !state.finished) saveFields(fields(), scope); });
  trackKeyboard();
  loadSite().then((value) => {
    site = value;
    if (value.signOutUrl) { $('#sign-out').href = value.signOutUrl; $('#sign-out').hidden = false; }
  }).catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
