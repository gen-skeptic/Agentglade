import { hydrateIcons, icon } from './icons.js?v=8';
import { getSession } from './auth.js?v=8';
import { loadManagedPosts, loadPost, loadSite, loadProfiles, deletePost } from './data.js?v=8';
import { setProfileDirectory } from './profile-directory.js?v=8';
import { renderPost, relativeTime, esc } from './render.js?v=8';

const $ = (selector) => document.querySelector(selector);
const state = { posts: new Map(), next: null, total: 0, loading: false, deleting: false, selected: null, session: null, site: {} };
const savedId = new URLSearchParams(location.search).get('saved');
function feedback(message, error = false) {
  $('#manage-feedback').textContent = message;
  $('#manage-feedback').classList.toggle('is-error', error);
  $('#manage-feedback').hidden = false;
}
function summary() {
  $('#manage-summary').textContent = `${state.total} post${state.total === 1 ? '' : 's'} · Signed in as ${state.session.name}`;
}
function card(post) {
  const canEdit = state.session.role !== 'contributor' || post.authorId === state.session.user;
  return `<section class="managed-entry${post.id === savedId ? ' is-saved' : ''}" data-post="${esc(post.id)}">
    ${post.id === savedId ? `<p class="managed-saved-label">${icon('check')}Just saved</p>` : ''}
    ${renderPost(post, { born: state.site.born, preview: true })}
    ${post.updatedAt ? `<p class="managed-edited">Edited ${esc(relativeTime(post.updatedAt))}</p>` : ''}
    <div class="managed-actions">
      ${canEdit ? `<a class="post-action" href="../compose/?edit=${encodeURIComponent(post.id)}">${icon('pen')}<span>Edit</span></a>` : ''}
      <a class="post-action" href="../#${encodeURIComponent(post.id)}">${icon('eye')}<span>View post</span></a>
      ${canEdit ? `<button class="post-action delete-action" type="button" data-delete="${esc(post.id)}">${icon('trash')}<span>Delete</span></button>` : ''}
    </div>
  </section>`;
}
async function loadPage(reset = false) {
  if (state.loading || !state.session) return;
  state.loading = true;
  $('#load-more').disabled = true;
  $('#load-more').textContent = 'Loading…';
  $('#refresh-posts').disabled = true;
  $('#managed-posts').setAttribute('aria-busy', 'true');
  try {
    const page = await loadManagedPosts(reset ? null : state.next);
    if (reset) { state.posts.clear(); $('#managed-posts').replaceChildren(); }
    for (const post of page.posts) {
      if (state.posts.has(post.id)) continue;
      state.posts.set(post.id, post);
      $('#managed-posts').insertAdjacentHTML('beforeend', card(post));
    }
    // Keep an older edited post visible when returning from the composer.
    if (reset && savedId && !state.posts.has(savedId)) {
      try {
        const post = await loadPost(savedId);
        state.posts.set(post.id, post);
        $('#managed-posts').insertAdjacentHTML('afterbegin', card(post));
      } catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
    }
    state.next = page.nextCursor;
    state.total = page.total;
    summary();
    if (!state.posts.size) $('#managed-posts').innerHTML = `<section class="community-empty">${icon('pen')}<h2>No posts yet</h2><p class="community-note">Share your first update with the community.</p><a class="button" href="../compose/">Create a post</a></section>`;
    $('#load-more').hidden = !state.next;
    $('#list-end').hidden = !!state.next || !state.posts.size;
  } catch (error) {
    if (!state.posts.size) $('#managed-posts').innerHTML = '<p class="feed-status">Could not load past posts. Use Refresh to try again.</p>';
    feedback(error.code === 'AUTH' ? 'Your sign-in expired. Refresh this page to sign in again.' : error.message, true);
  } finally {
    state.loading = false;
    $('#load-more').disabled = false;
    $('#load-more').textContent = 'Load older posts';
    $('#refresh-posts').disabled = false;
    $('#managed-posts').setAttribute('aria-busy', 'false');
  }
}
function confirmDeletion(id) {
  if (state.deleting) return;
  state.selected = state.posts.get(id);
  if (!state.selected) return;
  $('#delete-excerpt').textContent = state.selected.text?.slice(0, 200) || 'A photo or video post';
  $('#delete-error').hidden = true;
  $('#delete-dialog').showModal();
  $('#cancel-delete').focus();
}
async function remove(event) {
  event.preventDefault();
  if (state.deleting || !state.selected) return;
  state.deleting = true;
  $('#confirm-delete').disabled = true;
  $('#cancel-delete').disabled = true;
  $('#confirm-delete').textContent = 'Deleting…';
  const post = state.selected;
  try {
    await deletePost(post);
    state.posts.delete(post.id);
    document.querySelectorAll('[data-post]').forEach((element) => { if (element.dataset.post === post.id) element.remove(); });
    state.total = Math.max(0, state.total - 1);
    summary();
    $('#delete-dialog').close();
    feedback('Post deleted from the community feed.');
    state.selected = null;
    if (!state.posts.size) await loadPage(true);
    $('#refresh-posts').focus();
  } catch (error) {
    $('#delete-error').textContent = error.message;
    $('#delete-error').hidden = false;
  } finally {
    state.deleting = false;
    $('#confirm-delete').disabled = false;
    $('#cancel-delete').disabled = false;
    $('#confirm-delete').textContent = 'Delete post';
  }
}
async function init() {
  hydrateIcons();
  $('#refresh-posts').addEventListener('click', () => {
    if (!state.session) return location.reload();
    $('#manage-feedback').hidden = true;
    loadPage(true);
  });
  $('#load-more').addEventListener('click', () => { if (state.next) loadPage(); });
  $('#managed-posts').addEventListener('click', (event) => {
    const button = event.target.closest('[data-delete]');
    if (button) confirmDeletion(button.dataset.delete);
  });
  $('#delete-form').addEventListener('submit', remove);
  $('#cancel-delete').addEventListener('click', () => $('#delete-dialog').close());
  $('#delete-dialog').addEventListener('cancel', (event) => { if (state.deleting) event.preventDefault(); });
  const [session, site, profiles] = await Promise.all([getSession(), loadSite().catch(() => ({})), loadProfiles().catch(() => [])]);
  setProfileDirectory(profiles);
  state.session = session;
  state.site = site;
  if (!session) {
    $('#manage-summary').textContent = 'Community sign-in required';
    $('#managed-posts').innerHTML = '<p class="feed-status">You are offline or signed out. Refresh to reconnect.</p>';
    return;
  }
  if (savedId) feedback('Your post is saved on the community feed.');
  await loadPage(true);
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && state.next && !state.loading) loadPage();
    }, { rootMargin: '300px' });
    observer.observe($('#load-more'));
  }
}
init();
