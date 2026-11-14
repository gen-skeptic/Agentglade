import { hydrateIcons } from './icons.js?v=8';
import { loadSite, loadPosts, loadProfiles, resolve } from './data.js?v=8';
import { setProfileDirectory, postProfileId } from './profile-directory.js?v=8';
import { renderPost, formatAge, esc } from './render.js?v=8';

const $ = (s, r = document) => r.querySelector(s);
const LOVES = 'agentglade.loves';

let site = {};
let posts = [];
let profiles = [];
const selectedProfile = new URLSearchParams(location.search).get('profile');

const FILTERS = {
  all: () => true,
  photos: (p) => (p.media || []).length > 0,
  milestones: (p) => !!p.milestone,
};

function currentFilter() {
  const f = location.hash.slice(1);
  return FILTERS[f] ? f : 'all';
}

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
  facts.push(['Posts', String(posts.length)]);
  $('#profile-facts').innerHTML = facts.map(([k, v]) => `<li><span>${esc(k)}</span><span>${esc(v)}</span></li>`).join('');
}

function renderFeed() {
  const f = currentFilter();
  document.querySelectorAll('[data-filter]').forEach((a) => a.setAttribute('aria-current', String(a.dataset.filter === f)));
  const list = posts.filter(FILTERS[f]);
  const el = $('#posts');
  if (!list.length) {
    el.innerHTML = `<p class="feed-status">No ${f === 'all' ? 'posts' : f} yet.</p>`;
    return;
  }
  el.innerHTML = list.map((p) => renderPost(p, { born: site.born })).join('') +
    `<p class="feed-end">You're all caught up</p>`;
  restoreLoves();
}

function renderSidebars() {
  for (const [k, fn] of Object.entries(FILTERS)) {
    document.querySelectorAll(`[data-count="${k}"]`).forEach((c) => (c.textContent = posts.filter(fn).length));
  }
  const thumbs = posts.flatMap((p) => (p.media || []).map((m, i) => ({ p, m, i }))).filter(({ m }) => m.type !== 'video').slice(0, 9);
  $('#thumbs').innerHTML = thumbs.length
    ? thumbs.map(({ p, m, i }) => `<button type="button" data-open="${esc(p.id)}" data-index="${i}" aria-label="Open ${esc(m.alt || 'photo')}"><img src="${esc(resolve(m.previewSrc || m.src))}" alt="" loading="lazy"></button>`).join('')
    : '<p class="card-empty">Photos from posts show up here.</p>';
  const ms = posts.filter((p) => p.milestone);
  $('#milestones').innerHTML = ms.length
    ? ms.map((p) => `<li><a href="#${encodeURIComponent(p.id)}"><span><strong>${esc(p.milestone)}</strong><time datetime="${esc(p.publishedAt)}">${esc(new Date(p.publishedAt).toLocaleDateString(undefined, { dateStyle: 'medium' }))}</time></span></a></li>`).join('')
    : '<li class="card-empty">Mark a post as a milestone and it lands here.</li>';
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
  $('#lightbox-stage').innerHTML = m.type === 'video'
    ? `<video src="${src}" controls playsinline autoplay></video>`
    : `<img src="${src}" alt="${esc(m.alt || '')}">`;
  $('#lightbox-count').textContent = `${lb.i + 1} / ${lb.media.length}`;
  lb.el.querySelector('[data-step="-1"]').disabled = lb.i === 0;
  lb.el.querySelector('[data-step="1"]').disabled = lb.i === lb.media.length - 1;
}
function openLightbox(postId, index) {
  const p = posts.find((x) => x.id === postId);
  if (!p) return;
  lb.media = p.media; lb.i = index;
  showLightbox();
  lb.el.showModal();
}

document.addEventListener('click', async (e) => {
  const open = e.target.closest('[data-open]');
  if (open) return openLightbox(open.dataset.open, Number(open.dataset.index));

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

function init() {
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

  Promise.all([loadSite(), loadPosts(), loadProfiles()])
    .then(([s, p, directory]) => {
      profiles = directory; setProfileDirectory(profiles);
      site = s; posts = p;
      const profile = selectedProfile && profiles.find((item) => item.id === selectedProfile);
      if (profile) site = { ...site, name: profile.name, handle: profile.id, bio: profile.bio, avatar: profile.avatarPreview || profile.avatar };
      if (selectedProfile) posts = posts.filter((post) => postProfileId(post) === selectedProfile);
      renderProfile(); renderSidebars(); renderFeed();
      // Scroll to a permalinked post once rendered.
      const id = decodeURIComponent(location.hash.slice(1));
      if (id && !FILTERS[id]) document.getElementById(id)?.scrollIntoView();
    })
    .catch((err) => {
      console.error(err);
      $('#posts').innerHTML = '<p class="feed-status is-error">Couldn\'t load posts. Refresh to try again.</p>';
    });

  addEventListener('hashchange', () => {
    const h = location.hash.slice(1);
    if (FILTERS[h]) { renderFeed(); scrollTo({ top: 0 }); }
  });
}

init();
