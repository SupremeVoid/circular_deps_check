import { glob, escapePath } from 'tinyglobby';
import path from 'node:path';
import fs from 'node:fs';
import { normalizePath, isTsSource } from './util/paths.js';

/** Find all source files matched by include/exclude globs (relative to root). */
export const discoverFiles = async (
  root: string,
  include: string[],
  exclude: string[],
): Promise<string[]> => {
  const files = await glob(include, {
    cwd: root,
    ignore: exclude,
    absolute: true,
    onlyFiles: true,
    followSymbolicLinks: false,
  });
  const out = files.map(normalizePath).filter(isTsSource);
  out.sort();
  return out;
};

/**
 * Resolve entry patterns to absolute file paths. A pattern may be a plain path or a glob.
 * Only files that are part of `fileSet` are returned.
 */
export const resolveEntries = async (
  root: string,
  patterns: string[],
  fileSet: Set<string>,
): Promise<string[]> => {
  const result = new Set<string>();
  for (const pattern of patterns) {
    const direct = normalizePath(path.resolve(root, pattern));
    if (fs.existsSync(direct) && fs.statSync(direct).isFile()) {
      if (fileSet.has(direct)) result.add(direct);
      continue;
    }
    const matches = await glob([pattern], {
      cwd: root,
      absolute: true,
      onlyFiles: true,
      ignore: ['**/node_modules/**'],
    });
    for (const m of matches) {
      const n = normalizePath(m);
      if (fileSet.has(n)) result.add(n);
    }
  }
  return [...result].sort();
};

export { escapePath };
