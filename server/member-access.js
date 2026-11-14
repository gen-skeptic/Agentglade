// Explicit accounts and optional upstream groups control community membership.
// This private ledger only binds stable identities to public profiles.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const subjectOK = (subject) => typeof subject === 'string' && subject.length > 0 && subject.length <= 512 && !/^(?:local|agent):/.test(subject) && !/[\x00-\x20\x7f]/.test(subject);
const profileOK = (id) => typeof id === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(id);
export function createMemberAccess({ directory, accounts, owners = [], requiredRoles = [] }) {
  if (!Array.isArray(owners) || new Set(owners).size !== owners.length || owners.some((id) => typeof id !== 'string' || !Object.hasOwn(accounts || {}, id))) {
    throw new Error('MEMBER_ADMINS must list reviewed subjects from MEMBER_ACCOUNTS.');
  }
  if (!Array.isArray(requiredRoles) || requiredRoles.length > 16 || new Set(requiredRoles).size !== requiredRoles.length
    || requiredRoles.some((role) => typeof role !== 'string' || !role.trim() || role !== role.trim() || role.includes(',') || role.length > 100)) throw new Error('Invalid MEMBER_ROLES.');
  const ownerSet = new Set(owners), file = path.join(directory, '.member-profiles.json');
  let doc;
  function validate(value) {
    if (value?.schema !== 1 || !Array.isArray(value.accounts) || value.accounts.length > 250
      || new Set(value.accounts.map((a) => a.subject)).size !== value.accounts.length
      || value.accounts.some((a) => typeof a.subject !== 'string' || !a.subject || typeof a.name !== 'string' || typeof a.onboarded !== 'boolean'
        || (a.profileId !== null && !profileOK(a.profileId)))) throw new Error('Invalid community profile ledger; refusing to infer identity mappings.');
    const linked = value.accounts.filter((a) => a.profileId).map((a) => a.profileId);
    if (new Set(linked).size !== linked.length) throw new Error('Invalid community profile ledger: profile bindings must be unique.');
  }
  async function write(next) {
    validate(next);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(tmp, file); doc = next;
  }
  function allowed(who) {
    if (!who?.user) return false;
    // Administrator authority comes only from the configured subject allowlist.
    if (ownerSet.has(who.user)) return true;
    if (requiredRoles.length) return subjectOK(who.user) && String(who.proxyRole || '').split(',').map((r) => r.trim()).some((role) => requiredRoles.includes(role));
    return Object.hasOwn(accounts || {}, who.user);
  }
  const account = (subject) => doc?.accounts.find((a) => a.subject === subject);
  // True when this member's bound public profile is missing and ensure() must create it.
  const needsProfile = (who, profiles) => {
    const profileId = account(who.user)?.profileId;
    return !profileId || !profiles.some((p) => p.id === profileId);
  };
  const configured = (subject, config) => ({ subject, name: config.name || '', profileId: config.profileId || null, onboarded: !!config.profileId });
  return {
    async initialize() {
      try { doc = JSON.parse(await fs.readFile(file, 'utf8')); validate(doc); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await write({ schema: 1, accounts: Object.entries(accounts || {}).map(([subject, config]) => configured(subject, config)) });
        return;
      }
      // An account added to MEMBER_ACCOUNTS after the first start gets the same
      // binding a fresh install would give it. Bound accounts never move, and a
      // profile already bound to another account is never reassigned.
      let next = doc.accounts;
      for (const [subject, config] of Object.entries(accounts || {})) {
        const current = next.find((a) => a.subject === subject);
        if (current?.profileId) continue;
        const wanted = configured(subject, config);
        if (wanted.profileId && next.some((a) => a.profileId === wanted.profileId)) {
          console.warn(`MEMBER_ACCOUNTS binds profile "${wanted.profileId}", which is already bound to another account. That account keeps its own profile.`);
          Object.assign(wanted, { profileId: null, onboarded: false });
        }
        if (!current) next = [...next, wanted];
        else if (wanted.profileId || (!current.name && wanted.name)) {
          next = next.map((a) => a === current ? { ...current, name: current.name || wanted.name, profileId: wanted.profileId, onboarded: current.onboarded || wanted.onboarded } : a);
        }
      }
      if (next !== doc.accounts) await write({ ...doc, accounts: next });
    },
    account, allowed, needsProfile,
    session(who) {
      if (!allowed(who)) return null;
      const mapping = account(who.user);
      return { ...who, name: mapping?.name || who.name, profileId: mapping?.profileId || null,
        role: ownerSet.has(who.user) ? 'admin' : 'contributor', needsSetup: !ownerSet.has(who.user) && !mapping?.onboarded };
    },
    // Caller holds the same single-writer lock as post/profile mutations.
    // Commit the binding before creating its public profile. If interrupted,
    // the next request repairs that exact profile instead of creating a duplicate.
    async ensure(who, profiles) {
      if (!allowed(who)) return null;
      if (!needsProfile(who, profiles)) return null;
      let mapping = account(who.user);
      if (!mapping && doc.accounts.length >= 250) throw Object.assign(new Error('Community profile limit reached.'), { status: 503 });
      const name = mapping?.name || String(who.displayName || '').trim().slice(0, 60) || 'Community member';
      let id = mapping?.profileId;
      if (!id) {
        for (let n = 0; n < 250; n++) {
          const candidate = 'member-' + crypto.createHash('sha256').update(who.user + ':' + n).digest('hex').slice(0, 40);
          if (!profiles.some((p) => p.id === candidate) && !doc.accounts.some((a) => a.profileId === candidate)) { id = candidate; break; }
        }
        if (!id) throw Object.assign(new Error('Could not create a community profile.'), { status: 503 });
        mapping = { subject: who.user, name, profileId: id, onboarded: false };
        await write({ ...doc, accounts: [...doc.accounts.filter((a) => a.subject !== who.user), mapping] });
      }
      return { id, name, bio: '', avatar: null };
    },
    canEdit(who, item, kind = 'post') {
      if (!allowed(who)) return false;
      return ownerSet.has(who.user) || (kind === 'profile' ? account(who.user)?.profileId === item.id : item.authorId === who.user);
    },
    async finishSetup(who) {
      if (!allowed(who)) throw Object.assign(new Error('Community sign-in required.'), { status: 401 });
      const current = account(who.user);
      if (!current?.profileId) throw Object.assign(new Error('Profile not ready. Refresh and try again.'), { status: 409 });
      if (!current.onboarded) await write({ ...doc, accounts: doc.accounts.map((a) => a.subject === who.user ? { ...a, onboarded: true } : a) });
    },
  };
}
