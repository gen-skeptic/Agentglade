import { hydrateIcons } from './icons.js?v=8';
import { loadSite, loadFeedPage, loadFeedSummary, loadFeedPost, loadProfiles, resolve } from './data.js?v=8';
import { setProfileDirectory } from './profile-directory.js?v=8';
import { renderPost, formatAge, esc } from './render.js?v=8';

const $ = (s, r = document) => r.querySelector(s);
const LOVES = 'agentglade.loves';
const FILTERS = ['all', 'photos', 'milestones'];

let site = {};
let profiles = [];
const selectedProfile = new URLSearchParams(location.search).get('profile');
// Posts seen so far, by ID, for the lightbox and permalinks.
const known = new Map();
const feed = { filter: 'all', next: null, loading: false, generation: 0, summary: null };

function currentFilter() {
  const f = location.hash.slice(1);
  return FILTERS.includes(f) ? f : 'all';
}
const linkedId = () => { const h = decodeURIComponent(location.hash.slice(1)); return h && !FILTERS.includes(h) ? h : null; };

function renderProfile() {
  document.title = site.name || 'Agentglade';
  $('#profile-links').innerHTML = profiles.map((profile) => `<a href="${esc(resolve(`?profile=${profile.id}`))}">${esc(profile.name)}</a>`).join('');
  $('#profile-handle').textContent = site.handle || 'agentglade';
  $('#profile-bio').textContent = site.bio || '';
  if (site.avatar) { const a = $('#profile-avatar'); a.classList.add('is-photo'); a.innerHTML = `<img src="${esc(resolve(site.avatar))}" alt="">`; }
  const facts = [];
  if (site.born) {
    facts.push(['Born', new Date(site.born + 'T12:00:00').toLocaleDateString(undefined, { dateStyle: 'medium' })]);
    facts.push(['Age', formatAge(site.born)]);
  }
  if (site.hometown) facts.push(['Hometown', site.hometown]);
  facts.push(['Posts', String(feed.summary?.counts.all ?? '')]);
  $('#profile-facts').innerHTML = facts.map(([k, v]) => `<li><span>${esc(k)}</span><span>${esc(v)}</span></li>`).join('');
}

function renderSidebars() {
  const { counts, recentPhotos, milestones } = feed.summary;
  for (const [k, count] of Object.entries(counts)) document.querySelectorAll(`[data-count="${k}"]`).forEach((c) => (c.textContent = count));
  $('#thumbs').innerHTML = recentPhotos.length
    ? recentPhotos.map((m) => `<button type="button" data-open="${esc(m.postId)}" data-index="${m.index}" aria-label="Open ${esc(m.alt || 'photo')}"><img src="${esc(resolve(m.previewSrc || m.src))}" alt="" loading="lazy"></button>`).join('')
    : '<p class="card-empty">Photos from posts show up here.</p>';
  $('#milestones').innerHTML = milestones.length
    ? milestones.map((p) => `<li><a href="#${encodeURIComponent(p.postId)}"><span><strong>${esc(p.milestone)}</strong><time datetime="${esc(p.publishedAt)}">${esc(new Date(p.publishedAt).toLocaleDateString(undefined, { dateStyle: 'medium' }))}</time></span></a></li>`).join('')
    : '<li class="card-empty">Mark a post as a milestone and it lands here.</li>';
}

// The end of the list: a button (also loaded by scrolling near it), or the end marker.
function renderEnd() {
  $('#feed-more')?.remove();
  const el = $('#posts');
  if (feed.next) {
    el.insertAdjacentHTML('beforeend', `<div class="feed-more" id="feed-more"><button type="button" class="button button-small" data-more>${feed.loading ? 'Loading…' : 'Load older posts'}</button></div>`);
    observer?.observe($('#feed-more'));
  } else if (known.size) el.insertAdjacentHTML('beforeend', `<p class="feed-end" id="feed-more">You're all caught up</p>`);
}

async function loadPage(reset = false) {
  if (feed.loading || (!reset && !feed.next)) return;
  const generation = reset ? ++feed.generation : feed.generation;
  feed.loading = true;
  if (reset) { feed.filter = currentFilter(); feed.next = null; }
  document.querySelectorAll('[data-filter]').forEach((a) => a.setAttribute('aria-current', String(a.dataset.filter === feed.filter)));
  const button = $('[data-more]'); if (button) { button.disabled = true; button.textContent = 'Loading…'; }
  try {
    const page = await loadFeedPage({ before: reset ? null : feed.next, filter: feed.filter, profile: selectedProfile });
    if (generation !== feed.generation) return;
    const el = $('#posts');
    if (reset) el.replaceChildren();
    $('#feed-more')?.remove();
    for (const post of page.posts) {
      known.set(post.id, post);
      if (!document.getElementById(post.id)) el.insertAdjacentHTML('beforeend', renderPost(post, { born: site.born }));
    }
    feed.next = page.nextCursor;
    if (reset && !page.posts.length) el.innerHTML = `<p class="feed-status">No ${feed.filter === 'all' ? 'posts' : feed.filter} yet.</p>`;
    restoreLoves();
  } catch (err) {
    console.error(err);
    if (reset) $('#posts').innerHTML = '<p class="feed-status is-error">Couldn\'t load posts. Refresh to try again.</p>';
  } finally {
    if (generation === feed.generation) { feed.loading = false; renderEnd(); }
  }
}

// A permalinked post is shown above the feed when it is not already on the page.
async function showLinked(id) {
  $('#feed-linked')?.remove();
  let element = document.getElementById(id);
  if (!element) {
    let post;
    try { post = known.get(id) || await loadFeedPost(id); } catch { return; }
    known.set(post.id, post);
    $('#posts').insertAdjacentHTML('beforebegin', `<section class="feed-linked" id="feed-linked" aria-label="Linked post"><p class="feed-linked-note"><span>Linked post</span><a href="#all">Show all posts</a></p>${renderPost(post, { born: site.born })}</section>`);
    element = document.getElementById(id);
    restoreLoves();
  }
  element?.scrollIntoView();
}

/* ---- Love (saved on this device only until there's a backend) ---- */
function getLoves() { try { return new Set(JSON.parse(localStorage.getItem(LOVES)) || []); } catch { return new Set(); } }
function restoreLoves() {
  const loves = getLoves();
  document.querySelectorAll('[data-love]').forEach((b) => b.setAttribute('aria-pressed', String(loves.has(b.dataset.love))));
}

/* ---- Lightbox ---- */
const lb = { el: null, media: [], i: 0 };
function showLightbox() {
  const m = lb.media[lb.i];
  const src = esc(resolve(m.src));
  $('#lightbox-stage').innerHTML = m.type === 'video' && m.status
    ? `<p class="feed-status">${m.status === 'failed' ? 'This video could not be processed.' : 'This video is still processing.'}</p>`
    : m.type === 'video'
    ? `<video src="${src}"${m.posterSrc ? ` poster="${esc(resolve(m.posterSrc))}"` : ''} controls playsinline autoplay></video>`
    : `<img src="${src}" alt="${esc(m.alt || '')}">`;
  $('#lightbox-count').textContent = `${lb.i + 1} / ${lb.media.length}`;
  lb.el.querySelector('[data-step="-1"]').disabled = lb.i === 0;
  lb.el.querySelector('[data-step="1"]').disabled = lb.i === lb.media.length - 1;
}
async function openLightbox(postId, index) {
  let p = known.get(postId);
  if (!p) { try { p = await loadFeedPost(postId); known.set(p.id, p); } catch { return; } }
  if (!p.media?.[index]) return;
  lb.media = p.media; lb.i = index;
  showLightbox();
  lb.el.showModal();
}

document.addEventListener('click', async (e) => {
  const open = e.target.closest('[data-open]');
  if (open) return openLightbox(open.dataset.open, Number(open.dataset.index));
  if (e.target.closest('[data-more]')) return loadPage();

  const love = e.target.closest('[data-love]');
  if (love) {
    const loves = getLoves();
    loves.has(love.dataset.love) ? loves.delete(love.dataset.love) : loves.add(love.dataset.love);
    try { localStorage.setItem(LOVES, JSON.stringify([...loves])); } catch {}
    return restoreLoves();
  }

  const copy = e.target.closest('[data-copy]');
  if (copy) {
    const url = new URL(`#${encodeURIComponent(copy.dataset.copy)}`, location.href).href;
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ url, title: site.name });
      else await navigator.clipboard.writeText(url);
      copy.classList.add('is-done');
      copy.querySelector('span').textContent = 'Copied';
      setTimeout(() => { copy.classList.remove('is-done'); copy.querySelector('span').textContent = 'Copy link'; }, 1800);
    } catch { /* share sheet dismissed */ }
  }
});

const observer = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) loadPage(); }, { rootMargin: '600px' })
  : null;

async function init() {
  hydrateIcons();
  lb.el = $('#lightbox');
  lb.el.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) lb.el.close();
    const step = e.target.closest('[data-step]');
    if (step) { lb.i = Math.max(0, Math.min(lb.media.length - 1, lb.i + Number(step.dataset.step))); showLightbox(); }
  });
  lb.el.addEventListener('close', () => ($('#lightbox-stage').innerHTML = ''));
  document.addEventListener('keydown', (e) => {
    if (!lb.el.open) return;
    if (e.key === 'ArrowRight') lb.el.querySelector('[data-step="1"]').click();
    if (e.key === 'ArrowLeft') lb.el.querySelector('[data-step="-1"]').click();
  });
  addEventListener('hashchange', () => {
    const id = linkedId();
    if (id) return showLinked(id);
    $('#feed-linked')?.remove();
    if (currentFilter() !== feed.filter || !location.hash) { loadPage(true); scrollTo({ top: 0 }); }
  });

  try {
    const [s, directory, summary] = await Promise.all([loadSite(), loadProfiles(), loadFeedSummary(selectedProfile)]);
    profiles = directory; setProfileDirectory(profiles);
    site = s; feed.summary = summary;
    const profile = selectedProfile && profiles.find((item) => item.id === selectedProfile);
    if (profile) site = { ...site, name: profile.name, handle: profile.id, bio: profile.bio, avatar: profile.avatarPreview || profile.avatar };
    renderProfile(); renderSidebars();
  } catch (err) {
    console.error(err);
  }
  await loadPage(true);
  const id = linkedId();
  if (id) await showLinked(id);
}

init();
