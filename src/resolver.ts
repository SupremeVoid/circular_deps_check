import ts from 'typescript';
import path from 'node:path';
import { normalizePath } from './util/paths.js';

export interface ResolveResult {
  /** Normalized absolute path or null when the specifier could not be resolved. */
  path: string | null;
  /** The resolved file lives outside the analyzed set (node_modules / declaration files / other project). */
  external: boolean;
}

/**
 * Module resolver built on TypeScript's own resolution (honours `paths`, `baseUrl`, extensions,
 * index files and package.json `exports`). Results are cached per (containing dir, specifier).
 */
export class ModuleResolver {
  private readonly cache = new Map<string, ResolveResult>();
  private readonly host: ts.ModuleResolutionHost;
  private readonly resolutionCache: ts.ModuleResolutionCache;

  constructor(
    private readonly compilerOptions: ts.CompilerOptions,
    private readonly fileSet: Set<string>,
    private readonly root: string,
  ) {
    this.host = {
      fileExists: (f) => ts.sys.fileExists(f),
      readFile: (f) => ts.sys.readFile(f),
      directoryExists: (d) => ts.sys.directoryExists(d),
      getCurrentDirectory: () => root,
      getDirectories: (d) => ts.sys.getDirectories(d),
      realpath: ts.sys.realpath,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    };
    this.resolutionCache = ts.createModuleResolutionCache(
      root,
      (f) => (ts.sys.useCaseSensitiveFileNames ? f : f.toLowerCase()),
      compilerOptions,
    );
  }

  resolve(specifier: string, containingFile: string): ResolveResult {
    const key = `${path.dirname(containingFile)}\0${specifier}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const result = this.doResolve(specifier, containingFile);
    this.cache.set(key, result);
    return result;
  }

  private doResolve(specifier: string, containingFile: string): ResolveResult {
    // Strip query strings / fragments (e.g. `?raw`).
    const clean = specifier.replace(/[?#].*$/, '');
    if (clean === '') return { path: null, external: false };

    const res = ts.resolveModuleName(
      clean,
      containingFile,
      this.compilerOptions,
      this.host,
      this.resolutionCache,
    );
    const resolved = res.resolvedModule;
    if (resolved) {
      const p = normalizePath(resolved.resolvedFileName);
      if (this.fileSet.has(p)) return { path: p, external: false };
      if (resolved.isExternalLibraryImport || p.includes('/node_modules/')) {
        return { path: p, external: true };
      }
      // A `.d.ts` next to a `.js` or a file outside the analyzed set.
      const sibling = this.siblingSource(p);
      if (sibling && this.fileSet.has(sibling)) return { path: sibling, external: false };
      return { path: p, external: true };
    }

    // Fallback for relative specifiers TS could not resolve (e.g. `.js` suffix mapping).
    if (clean.startsWith('.') || clean.startsWith('/')) {
      const base = path.resolve(path.dirname(containingFile), clean);
      const candidates = [
        base,
        base.replace(/\.js$/, '.ts'),
        base.replace(/\.mjs$/, '.mts'),
        `${base}.ts`,
        `${base}.tsx`,
        path.join(base, 'index.ts'),
      ];
      for (const cnd of candidates) {
        const n = normalizePath(cnd);
        if (this.fileSet.has(n)) return { path: n, external: false };
      }
    }
    return { path: null, external: false };
  }

  private siblingSource(p: string): string | null {
    const m = /^(.*)\.d\.(ts|mts|cts)$/.exec(p);
    if (!m) return null;
    const ext = m[2] === 'ts' ? 'ts' : m[2]!;
    return `${m[1]}.${ext}`;
  }

  isExternalPackage(specifier: string): boolean {
    return !specifier.startsWith('.') && !specifier.startsWith('/') && !this.matchesPaths(specifier);
  }

  private matchesPaths(specifier: string): boolean {
    const paths = this.compilerOptions.paths;
    if (!paths) return false;
    for (const pattern of Object.keys(paths)) {
      const star = pattern.indexOf('*');
      if (star === -1) {
        if (pattern === specifier) return true;
      } else {
        const prefix = pattern.slice(0, star);
        const suffix = pattern.slice(star + 1);
        if (specifier.startsWith(prefix) && specifier.endsWith(suffix)) return true;
      }
    }
    return false;
  }
}
