import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { normalizePath, toPosix } from './util/paths.js';

export interface CircdepsOptions {
  /** Project root (directory containing tsconfig.json / package.json). */
  root?: string;
  /** Path to tsconfig used for module resolution (paths/baseUrl). Auto-detected when omitted. */
  tsconfig?: string | null;
  /** Glob patterns (relative to root) of files to analyze. */
  include?: string[];
  /** Glob patterns (relative to root) to exclude. */
  exclude?: string[];
  /** Entry points evaluated first (globs or paths). Default: src/main.ts if present. */
  entries?: string[];
  /** Test entry globs; each test file is evaluated in isolation. Default: **\/*.spec.ts */
  testEntries?: string[];
  /** Disable test-entry evaluation. */
  noTestEntries?: boolean;
  /** Maximum number of elementary cycles enumerated per strongly connected component. */
  maxCyclesPerScc?: number;
  /** Maximum cycle length considered during enumeration. */
  maxCycleLength?: number;
  /** Maximum number of findings printed per severity in the text report. */
  maxFindingsPerSeverity?: number;
  /** Override tsconfig's emitDecoratorMetadata detection. */
  emitDecoratorMetadata?: boolean;
  /** Treat constructor parameter types as DI dependencies (default true). */
  angular?: boolean;
  /** Report type-only cycles as info findings (default true, hidden in text output). */
  reportTypeOnly?: boolean;
}

export interface ResolvedConfig {
  root: string;
  tsconfigPath: string | null;
  compilerOptions: ts.CompilerOptions;
  include: string[];
  exclude: string[];
  entries: string[];
  testEntries: string[];
  maxCyclesPerScc: number;
  maxCycleLength: number;
  maxFindingsPerSeverity: number;
  emitDecoratorMetadata: boolean;
  verbatimModuleSyntax: boolean;
  /** tsconfig `isolatedModules` (decides whether `const enum` members are inlined across files). */
  isolatedModules: boolean;
  angular: boolean;
  reportTypeOnly: boolean;
}

export const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.angular/**',
  '**/coverage/**',
  '**/out-tsc/**',
  '**/*.d.ts',
];

export const DEFAULT_INCLUDE = ['**/*.{ts,tsx,mts,cts}'];

const findTsconfig = (root: string): string | null => {
  for (const candidate of ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.base.json']) {
    const p = path.join(root, candidate);
    if (fs.existsSync(p)) return p;
  }
  return null;
};

export const loadCompilerOptions = (
  tsconfigPath: string | null,
  root: string,
): ts.CompilerOptions => {
  if (!tsconfigPath) return { moduleResolution: ts.ModuleResolutionKind.Bundler };
  const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (read.error) {
    throw new Error(
      `Failed to read ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    path.dirname(tsconfigPath),
    undefined,
    tsconfigPath,
  );
  const options = { ...parsed.options };
  // Resolution must work even when the project targets an exotic module system.
  if (
    options.moduleResolution === undefined ||
    options.moduleResolution === ts.ModuleResolutionKind.Classic
  ) {
    options.moduleResolution = ts.ModuleResolutionKind.Bundler;
    options.module = ts.ModuleKind.ESNext;
  }
  if (!options.baseUrl && options.paths && !options.pathsBasePath) {
    options.pathsBasePath = root;
  }
  return options;
};

/** Load an optional `circdeps.config.json` from root and merge with CLI options. */
export const loadConfigFile = (root: string): CircdepsOptions => {
  const p = path.join(root, 'circdeps.config.json');
  if (!fs.existsSync(p)) return {};
  const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as CircdepsOptions;
  return raw;
};

export const resolveConfig = (opts: CircdepsOptions): ResolvedConfig => {
  const root = normalizePath(opts.root ?? process.cwd());
  const fileOpts = loadConfigFile(root);
  const merged: CircdepsOptions = { ...fileOpts, ...stripUndefined(opts) };

  const tsconfigPath =
    merged.tsconfig === null
      ? null
      : merged.tsconfig
        ? normalizePath(path.resolve(root, merged.tsconfig))
        : findTsconfig(root);
  const compilerOptions = loadCompilerOptions(tsconfigPath, root);

  const entries = merged.entries ?? defaultEntries(root);
  const testEntries = merged.noTestEntries ? [] : (merged.testEntries ?? ['**/*.spec.ts']);

  return {
    root,
    tsconfigPath: tsconfigPath ? toPosix(tsconfigPath) : null,
    compilerOptions,
    include: merged.include ?? DEFAULT_INCLUDE,
    exclude: [...DEFAULT_EXCLUDE, ...(merged.exclude ?? [])],
    entries,
    testEntries,
    maxCyclesPerScc: merged.maxCyclesPerScc ?? 200,
    maxCycleLength: merged.maxCycleLength ?? 25,
    maxFindingsPerSeverity: merged.maxFindingsPerSeverity ?? 40,
    emitDecoratorMetadata:
      merged.emitDecoratorMetadata ?? Boolean(compilerOptions.emitDecoratorMetadata),
    isolatedModules: Boolean(compilerOptions.isolatedModules || compilerOptions.verbatimModuleSyntax),
    verbatimModuleSyntax: Boolean(
      compilerOptions.verbatimModuleSyntax || compilerOptions.preserveValueImports,
    ),
    angular: merged.angular ?? true,
    reportTypeOnly: merged.reportTypeOnly ?? true,
  };
};

const defaultEntries = (root: string): string[] => {
  const candidates = ['src/main.ts', 'main.ts', 'src/index.ts', 'index.ts'];
  const found = candidates.filter((c) => fs.existsSync(path.join(root, c)));
  return found.length > 0 ? [found[0]!] : [];
};

const stripUndefined = <T extends object>(o: T): T => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
};
