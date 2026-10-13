import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze } from '../src/index.js';
import type { AnalysisResult } from '../src/types.js';
import { normalizePath } from '../src/util/paths.js';

const TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ES2022', module: 'ES2022', moduleResolution: 'bundler', strict: true, isolatedModules: true, experimentalDecorators: true },
});

/** Create a throw-away project from a `relative path -> source` map and analyze it. */
export const analyzeProject = async (
  files: Record<string, string>,
  opts: { entries?: string[]; testEntries?: string[]; noTestEntries?: boolean; emitDecoratorMetadata?: boolean; angular?: boolean; compilerOptions?: Record<string, unknown>; include?: string[] } = {},
): Promise<AnalysisResult & { dir: string; file: (rel: string) => string }> => {
  const dir = normalizePath(fs.mkdtempSync(path.join(os.tmpdir(), 'circdeps-proj-')));
  const tsconfig = JSON.parse(TSCONFIG) as { compilerOptions: Record<string, unknown> };
  Object.assign(tsconfig.compilerOptions, opts.compilerOptions ?? {});
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(tsconfig));
  for (const [rel, src] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, src);
  }
  const result = await analyze({ root: dir, entries: opts.entries ?? ['src/main.ts'], noTestEntries: opts.noTestEntries ?? true, testEntries: opts.testEntries, emitDecoratorMetadata: opts.emitDecoratorMetadata, angular: opts.angular, include: opts.include });
  return Object.assign(result, { dir, file: (rel: string) => normalizePath(path.join(dir, rel)) });
};
