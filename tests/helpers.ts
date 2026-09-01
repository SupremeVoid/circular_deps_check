import path from 'node:path';
import { analyze } from '../src/index.js';
import type { AnalysisResult, Finding } from '../src/types.js';
import { normalizePath } from '../src/util/paths.js';

export const projectRoot = normalizePath(path.join(import.meta.dir, '..'));

export const fixturePath = (name: string): string => normalizePath(path.join(projectRoot, 'fixtures', name));

const cache = new Map<string, Promise<AnalysisResult>>();

/** Analyze a fixture once per test run (results are immutable for assertions). */
export const analyzeFixture = (name: string, extra: Record<string, unknown> = {}): Promise<AnalysisResult> => {
  const key = `${name}:${JSON.stringify(extra)}`;
  let p = cache.get(key);
  if (!p) {
    p = analyze({ root: fixturePath(name), entries: ['src/main.ts'], ...extra });
    cache.set(key, p);
  }
  return p;
};

export const endsWith = (p: string, suffix: string): boolean => p.replace(/\\/g, '/').endsWith(suffix);

export const findingsOfKind = (result: AnalysisResult, kind: Finding['kind']): Finding[] => result.findings.filter((f) => f.kind === kind);

export const cycleFiles = (f: Finding): string[] => (f.cycle?.nodes ?? []).map((n) => n.split('/').slice(-2).join('/'));
