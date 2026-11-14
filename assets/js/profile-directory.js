const directory = new Map();
export function setProfileDirectory(profiles) { directory.clear(); for (const profile of profiles) directory.set(profile.id, profile); }
export const postProfileId = (post) => post.profileId || null;
export const profileForPost = (post) => directory.get(postProfileId(post));
