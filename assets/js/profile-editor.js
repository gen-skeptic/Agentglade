import { getSession } from './auth.js?v=8';
import { loadEditableProfiles, updateProfile, finishProfileSetup, resolve } from './data.js?v=8';
import { hydrateIcons } from './icons.js?v=8';
import { esc } from './render.js?v=8';

const $ = (selector) => document.querySelector(selector);
const onboarding = location.pathname.startsWith('/welcome/');
let id = new URLSearchParams(location.search).get('id');
let current, photo, photoUrl;
const initials = (name) => name.split(/\s+/).map((word) => word[0]).join('').slice(0, 2).toUpperCase();
function avatar(profile) {
  const src = profile.avatarPreview || profile.avatar;
  return src ? `<img src="${esc(resolve(src))}" alt="">` : esc(initials(profile.name));
}
function feedback(text, failed = false) {
  const element = $('#profile-feedback'); element.hidden = false; element.textContent = text;
  element.classList.toggle('is-error', failed);
}
function preview() {
  const name = $('#profile-name').value.trim() || current.name;
  $('#profile-preview-name').textContent = name;
  $('#profile-preview-bio').textContent = $('#profile-bio-field').value.trim() || 'Add a bio when you are ready.';
  $('#profile-preview-avatar').innerHTML = photoUrl ? `<img src="${esc(photoUrl)}" alt="">`
    : $('#remove-avatar').checked ? esc(initials(name)) : avatar({ ...current, name });
}
async function init() {
  hydrateIcons();
  const session = await getSession();
  if (!session) { feedback('Sign in through the community login to edit profiles.', true); return; }
  if (onboarding) id = session.profileId;
  $('#profile-login').textContent = `Signed in as ${session.name}${session.role === 'admin' ? ' · Admin' : ''}`;
  const { profiles } = await loadEditableProfiles();
  if (!id) {
    $('#profile-list').innerHTML = profiles.map((profile) => `<article class="profile-card">
      <span class="avatar profile-list-avatar">${avatar(profile)}</span><div><h2>${esc(profile.name)}</h2>
      <p>${esc(profile.bio || 'Ready for your bio and photo.')}</p>${session.role !== 'contributor' || session.profileId === profile.id ? `<a class="button button-small" href="edit/?id=${encodeURIComponent(profile.id)}">Edit profile</a>` : ''}
      <a class="profile-view-link" href="../?profile=${encodeURIComponent(profile.id)}">View profile</a></div></article>`).join('');
    return;
  }
  current = profiles.find((profile) => profile.id === id);
  if (!current) { feedback('This profile could not be found.', true); return; }
  if (session.role === 'contributor' && session.profileId !== id) { feedback('You can edit your own profile. Choose it from Profiles.', true); return; }
  document.title = onboarding ? 'Welcome to the community · Agentglade' : `Edit ${current.name} · Agentglade`;
  $('#profile-editor-title').textContent = onboarding ? 'Make yourself at home' : `Edit ${current.name}`;
  $('#profile-name').value = current.name; $('#profile-bio-field').value = current.bio;
  $('#profile-fields').disabled = false;
  preview();
  $('#profile-form').addEventListener('input', preview);
  $('#profile-photo').addEventListener('change', async (event) => {
    photo = event.target.files[0];
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = null;
    if (photo) $('#remove-avatar').checked = false;
    if (photo) {
      $('#profile-fields').disabled = true;
      feedback('Preparing profile photo…');
      try {
        const { preparePreview } = await import('./media.js?v=8');
        const thumbnail = await preparePreview(photo);
        if (thumbnail) photoUrl = URL.createObjectURL(thumbnail);
        feedback(thumbnail ? 'Photo ready. Save the profile to publish your changes.' : 'Photo selected. Its preview will appear after saving.');
      } finally { $('#profile-fields').disabled = false; }
    }
    preview();
  });
  $('#remove-avatar').addEventListener('change', () => {
    if ($('#remove-avatar').checked) { photo = null; $('#profile-photo').value = ''; if (photoUrl) URL.revokeObjectURL(photoUrl); photoUrl = null; }
    preview();
  });
  $('#profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('#profile-fields').disabled = true;
    feedback('Saving profile…');
    try {
      // Use the same sequential photo preparation as posts before uploading.
      let file = photo;
      if (file) { const { prepareMedia } = await import('./media.js?v=8'); file = (await prepareMedia([file]))[0].file; }
      current = await updateProfile(id, current.version, { name: $('#profile-name').value, bio: $('#profile-bio-field').value,
        avatar: file, removeAvatar: $('#remove-avatar').checked });
      photo = null; $('#profile-photo').value = ''; $('#remove-avatar').checked = false;
      if (photoUrl) URL.revokeObjectURL(photoUrl); photoUrl = null;
      if (onboarding) { location.assign(resolve('manage/')); return; }
      preview(); feedback('Profile saved. It is now visible on the feed and profile page.');
    } catch (error) { feedback(error.code === 'CONFLICT' ? 'This profile changed in another window. Reload before saving; your unsaved changes are still here.' : error.message, true); }
    finally { $('#profile-fields').disabled = false; }
  });
  $('#skip-setup')?.addEventListener('click', async () => {
    $('#skip-setup').disabled = true; $('#profile-fields').disabled = true;
    try { await finishProfileSetup(); location.assign(resolve('manage/')); }
    catch (error) { feedback(error.message, true); $('#skip-setup').disabled = false; $('#profile-fields').disabled = false; }
  });
  addEventListener('pagehide', () => { if (photoUrl) URL.revokeObjectURL(photoUrl); });
}
init().catch(() => feedback('Profiles could not load. Check your connection and reload.', true));
