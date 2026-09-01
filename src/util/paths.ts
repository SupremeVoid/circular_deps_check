import path from 'node:path';

/** Normalise to forward slashes and absolute form; lower-case drive letter on Windows. */
export const normalizePath = (p: string): string => {
  let abs = path.resolve(p).replace(/\\/g, '/');
  if (/^[A-Z]:\//.test(abs)) abs = abs[0]!.toLowerCase() + abs.slice(1);
  return abs;
};

export const toPosix = (p: string): string => p.replace(/\\/g, '/');

export const relativeTo = (root: string, p: string): string => {
  const rel = toPosix(path.relative(root, p));
  return rel.startsWith('..') || path.isAbsolute(rel) ? p : rel;
};

export const isTsSource = (p: string): boolean =>
  /\.(ts|tsx|mts|cts)$/.test(p) && !/\.d\.(ts|mts|cts)$/.test(p);

export const baseName = (p: string): string => path.posix.basename(toPosix(p));

/** A short display name: last two segments. */
export const shortName = (p: string): string => {
  const parts = toPosix(p).split('/');
  return parts.slice(-2).join('/');
};
