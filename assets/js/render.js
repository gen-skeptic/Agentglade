import { icon } from './icons.js?v=8';
import { resolve } from './data.js?v=8';
import { profileForPost } from './profile-directory.js?v=8';

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DAY = 86400000;

export function ageOn(born, date) {
  if (!born) return null;
  const days = Math.floor((new Date(date) - new Date(born)) / DAY);
  return days >= 0 ? days : null;
}

export function formatAge(born, now = new Date()) {
  const days = ageOn(born, now);
  if (days == null) return null;
  if (days < 14) return `${days} day${days === 1 ? '' : 's'}`;
  if (days < 7 * 13) return `${Math.floor(days / 7)} weeks`;
  const b = new Date(born);
  let months = (now.getFullYear() - b.getFullYear()) * 12 + now.getMonth() - b.getMonth();
  if (now.getDate() < b.getDate()) months -= 1;
  if (months < 24) return `${months} months`;
  return `${Math.floor(months / 12)} years`;
}

export function relativeTime(iso, now = Date.now()) {
  const diff = (now - new Date(iso)) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (Math.abs(diff) < 60) return 'just now';
  if (Math.abs(diff) < 3600) return rtf.format(-Math.round(diff / 60), 'minute');
  if (Math.abs(diff) < 86400) return rtf.format(-Math.round(diff / 3600), 'hour');
  if (Math.abs(diff) < 86400 * 7) return rtf.format(-Math.round(diff / 86400), 'day');
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export const fullDate = (iso) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' });

function textToHtml(text = '') {
  return text.trim().split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
}

function mediaHtml(post, interactive = true) {
  const items = post.media || [];
  if (!items.length) return '';
  const shown = items.slice(0, 4);
  const cls = `media media-${Math.min(items.length, 4)}`;
  const cells = shown.map((m, i) => {
    const src = resolve(m.previewSrc || m.src);
    const inner = m.pendingPreview ? '<span class="media-pending">Photo preview available after posting</span>' : m.type === 'video'
      ? `<video src="${esc(src)}" muted playsinline preload="metadata"></video><span class="media-play">${icon('play')}</span>`
      : `<img src="${esc(src)}" alt="${esc(m.alt || '')}" loading="lazy" decoding="async"${m.width ? ` width="${m.width}" height="${m.height}"` : ''}>`;
    const more = i === 3 && items.length > 4 ? `<span class="media-more">+${items.length - 4}</span>` : '';
    return interactive
      ? `<button type="button" class="media-item" data-open="${esc(post.id)}" data-index="${i}" aria-label="Open ${m.type === 'video' ? 'video' : 'photo'} ${i + 1} of ${items.length}${m.alt ? `: ${esc(m.alt)}` : ''}">${inner}${more}</button>`
      : `<div class="media-item">${inner}${more}</div>`;
  }).join('');
  return `<div class="${cls}">${cells}</div>`;
}

export function renderPost(post, { born = null, preview = false } = {}) {
  const profile = profileForPost(post);
  if (profile) post = { ...post, author: profile.name, initials: profile.name.split(/\s+/).map((word) => word[0]).join('').slice(0, 2), avatar: profile.avatarPreview || profile.avatar };
  const day = ageOn(born, post.publishedAt);
  const initials = esc(post.initials || (post.author || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase());
  const permalink = `#${encodeURIComponent(post.id)}`;
  const actions = preview ? '' : `
    <div class="post-actions">
      <button type="button" class="post-action" data-love="${esc(post.id)}" aria-pressed="false">${icon('heart')}<span>Love</span></button>
      <button type="button" class="post-action" data-copy="${esc(post.id)}">${icon('link')}<span>Copy link</span></button>
    </div>`;
  return `
  <article class="post" id="${esc(post.id)}" aria-labelledby="${esc(post.id)}-by">
    <header class="post-head">
      ${profile ? `<a class="avatar" href="${esc(resolve(`?profile=${profile.id}`))}" aria-label="View ${esc(post.author)} profile">${post.avatar ? `<img src="${esc(resolve(post.avatar))}" alt="">` : initials}</a>` : `<span class="avatar" aria-hidden="true">${initials}</span>`}
      <div class="post-who">
        ${profile ? `<a class="post-author" id="${esc(post.id)}-by" href="${esc(resolve(`?profile=${profile.id}`))}">${esc(post.author)}</a>` : `<span class="post-author" id="${esc(post.id)}-by">${esc(post.author)}</span>`}
        <span class="post-when">
          <a href="${permalink}"><time datetime="${esc(post.publishedAt)}" title="${esc(fullDate(post.publishedAt))}">${esc(relativeTime(post.publishedAt))}</time></a>
          ${day != null ? `<span class="sep">·</span><span>Day ${day}</span>` : ''}
        </span>
      </div>
      ${post.milestone ? `<span class="tag">${icon('flag')}${esc(post.milestone)}</span>` : ''}
    </header>
    ${post.text ? `<div class="post-text">${textToHtml(post.text)}</div>` : ''}
    ${mediaHtml(post, !preview)}
    ${actions}
  </article>`;
}

export { esc };
