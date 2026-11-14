// Local sessions and optional upstream SSO are reported by /api/me.
import { resolve, visitorId, linkVisitor } from './data.js?v=8';

export async function getSession() {
  let res;
  try {
    res = await fetch(resolve('api/me'), { cache: 'no-store', credentials: 'same-origin', redirect: 'manual' });
  } catch {
    return null; // offline
  }
  if (res.type === 'opaqueredirect' || res.status === 401) {
    location.assign(resolve('login/'));
    return new Promise(() => {});
  }
  const session = res.ok ? await res.json() : null;
  if (session?.needsSetup && !location.pathname.startsWith('/welcome/')) {
    location.replace(resolve('welcome/'));
    return new Promise(() => {});
  }
  if (session?.user) {
    // Loves this browser gives on the public feed now count as this member's, on every device.
    try {
      const LINKED = 'agentglade.visitor.linked', mark = `${visitorId()}:${session.profileId || session.name}`;
      if (localStorage.getItem(LINKED) !== mark) linkVisitor().then((res) => { if (res.ok) localStorage.setItem(LINKED, mark); }).catch(() => {});
    } catch { /* Storage blocked: loves stay with this page's visit. */ }
  }
  return session;
}
