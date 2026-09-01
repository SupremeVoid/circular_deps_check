import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import { ModuleResolver } from '../src/resolver.js';
import { loadCompilerOptions } from '../src/config.js';
import { normalizePath } from '../src/util/paths.js';

const fixture = (name: string): string => normalizePath(path.join(import.meta.dir, '..', 'fixtures', name));

const setup = (name: string, files: string[]) => {
  const root = fixture(name);
  const fileSet = new Set(files.map((f) => normalizePath(path.join(root, f))));
  const options = loadCompilerOptions(path.join(root, 'tsconfig.json'), root);
  return { root, fileSet, resolver: new ModuleResolver(options, fileSet, root) };
};

describe('ModuleResolver', () => {
  it('resolves relative imports with and without extension', () => {
    const { root, resolver } = setup('01-basic', ['src/main.ts', 'src/app/app.ts', 'src/app/config.ts']);
    const from = normalizePath(path.join(root, 'src/main.ts'));
    expect(resolver.resolve('./app/app', from)).toEqual({ path: normalizePath(path.join(root, 'src/app/app.ts')), external: false });
    expect(resolver.resolve('./app/app.ts', from).path).toBe(normalizePath(path.join(root, 'src/app/app.ts')));
    expect(resolver.resolve('./app/app.js', from).path).toBe(normalizePath(path.join(root, 'src/app/app.ts')));
  });

  it('resolves tsconfig path aliases including exact alias to a barrel', () => {
    const { root, resolver } = setup('02-barrels', [
      'src/main.ts',
      'src/shared/index.ts',
      'src/shared/state.ts',
      'src/features/user/user.component.ts',
    ]);
    const from = normalizePath(path.join(root, 'src/main.ts'));
    expect(resolver.resolve('@shared', from).path).toBe(normalizePath(path.join(root, 'src/shared/index.ts')));
    expect(resolver.resolve('@shared/state', from).path).toBe(normalizePath(path.join(root, 'src/shared/state.ts')));
    expect(resolver.resolve('@features/user/user.component', from).path).toBe(
      normalizePath(path.join(root, 'src/features/user/user.component.ts')),
    );
    expect(resolver.isExternalPackage('@shared/state')).toBe(false);
    expect(resolver.isExternalPackage('@angular/core')).toBe(true);
  });

  it('resolves a directory to its index file', () => {
    const { root, resolver } = setup('02-barrels', ['src/main.ts', 'src/shared/index.ts']);
    const from = normalizePath(path.join(root, 'src/main.ts'));
    expect(resolver.resolve('./shared', from).path).toBe(normalizePath(path.join(root, 'src/shared/index.ts')));
  });

  it('marks unknown packages as external and unresolvable relative paths as null', () => {
    const { root, resolver } = setup('01-basic', ['src/main.ts']);
    const from = normalizePath(path.join(root, 'src/main.ts'));
    const ng = resolver.resolve('@angular/core', from);
    expect(ng.path).toBeNull();
    expect(resolver.isExternalPackage('@angular/core')).toBe(true);
    expect(resolver.resolve('./does-not-exist', from)).toEqual({ path: null, external: false });
  });

  it('marks files outside the analyzed set as external', () => {
    const { root, resolver } = setup('01-basic', ['src/main.ts']);
    const from = normalizePath(path.join(root, 'src/main.ts'));
    const res = resolver.resolve('./app/app', from);
    expect(res.external).toBe(true);
    expect(res.path).toBe(normalizePath(path.join(root, 'src/app/app.ts')));
  });

  it('caches results per directory and specifier', () => {
    const { root, resolver } = setup('01-basic', ['src/main.ts', 'src/app/app.ts']);
    const from = normalizePath(path.join(root, 'src/main.ts'));
    const a = resolver.resolve('./app/app', from);
    const b = resolver.resolve('./app/app', from);
    expect(a).toBe(b);
  });
});
