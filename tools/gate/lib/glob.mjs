// Minimal glob matching for repository paths: `**` spans folders, `*` and `?` stay inside one.

const cache = new Map();

/** A glob as a RegExp; `ignoreCase` for paths a case-insensitive file system (Windows) treats as one. */
export function globToRegExp(glob, { ignoreCase = false } = {}) {
  const key = `${ignoreCase ? 'i' : 's'}\u0000${glob}`;
  if (cache.has(key)) return cache.get(key);
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const rx = new RegExp(`^${re}$`, ignoreCase ? 'i' : '');
  cache.set(key, rx);
  return rx;
}

export function matches(p, globs, opts) {
  const list = Array.isArray(globs) ? globs : [globs];
  return list.some((g) => globToRegExp(g, opts).test(p));
}
