/**
 * ES module evaluation-order simulation.
 *
 * ESM evaluates a module graph depth-first in import order. When module A is being evaluated and
 * (transitively) imports B, and B imports A again, B receives A's bindings *before* A's body ran:
 * `class`/`const`/`let` exports are in the temporal dead zone (ReferenceError), `var`/`enum`
 * exports are `undefined`, and function declarations are already initialised (hoisted).
 *
 * This module replays that order from each entry point and records every eager usage of a
 * binding that is not initialised at that moment — those are the cycles that really crash.
 */
import type {
  BindingState,
  EdgeBreakage,
  EntryEvaluation,
  ExportKind,
  FailingUsage,
  GraphEdge,
  ImportRecord,
  ModuleGraph,
} from './types.js';
import { resolveExport, type ResolvedExport } from './graph.js';

type EvalState = 0 | 1 | 2; // unvisited | in-progress | done

interface Dep {
  to: string;
  record: ImportRecord;
}

const bindingStateFor = (kind: ExportKind, hoisted: boolean): BindingState => {
  if (hoisted || kind === 'function') return 'hoisted';
  if (kind === 'var' || kind === 'enum' || kind === 'namespace') return 'undefined';
  return 'tdz';
};

export class Evaluator {
  private readonly deps = new Map<string, Dep[]>();
  private readonly dynamicTargets = new Map<string, string[]>();
  private readonly exportCache = new Map<string, ResolvedExport | null>();

  constructor(private readonly graph: ModuleGraph) {
    for (const mod of graph.modules.values()) {
      const list: Dep[] = [];
      const dyn: string[] = [];
      const sorted = [...mod.imports].sort((a, b) => a.line - b.line || a.column - b.column);
      for (const record of sorted) {
        if (!record.resolvedPath || record.external || !graph.modules.has(record.resolvedPath)) continue;
        if (record.resolvedPath === mod.path) continue;
        if (record.kind === 'dynamic') {
          dyn.push(record.resolvedPath);
          continue;
        }
        if (record.erased) continue;
        list.push({ to: record.resolvedPath, record });
      }
      this.deps.set(mod.path, list);
      this.dynamicTargets.set(mod.path, dyn);
    }
  }

  /**
   * Evaluate starting at `entry`. Dynamic import targets discovered along the way are evaluated
   * afterwards as lazy roots sharing the same state (already-loaded modules are not re-run).
   */
  evaluateEntry(entry: string, kind: 'main' | 'test'): EntryEvaluation[] {
    const state = new Map<string, EvalState>();
    const results: EntryEvaluation[] = [];
    const lazyQueue: string[] = [];
    const queued = new Set<string>([entry]);

    const run = (root: string, rootKind: 'main' | 'test' | 'lazy'): void => {
      const breakages: EdgeBreakage[] = [];
      let evaluated = 0;
      const dfs = (start: string): void => {
        const stack: { node: string; i: number }[] = [];
        const path: string[] = [];
        const enter = (n: string): void => {
          state.set(n, 1);
          stack.push({ node: n, i: 0 });
          path.push(n);
          for (const d of this.dynamicTargets.get(n) ?? []) {
            if (!queued.has(d)) {
              queued.add(d);
              lazyQueue.push(d);
            }
          }
        };
        enter(start);
        while (stack.length > 0) {
          const frame = stack[stack.length - 1]!;
          const deps = this.deps.get(frame.node) ?? [];
          if (frame.i < deps.length) {
            const dep = deps[frame.i++]!;
            const s = state.get(dep.to) ?? 0;
            if (s === 0) {
              enter(dep.to);
            } else if (s === 1) {
              const b = this.analyzeBackEdge(frame.node, dep.to, state, path);
              if (b) {
                const existing = breakages.find((x) => x.from === b.from && x.to === b.to);
                if (existing) {
                  existing.failing.push(...b.failing);
                  existing.deferredCount += b.deferredCount;
                } else {
                  breakages.push(b);
                }
              }
            }
            continue;
          }
          stack.pop();
          path.pop();
          state.set(frame.node, 2);
          evaluated++;
        }
      };
      if ((state.get(root) ?? 0) === 0) dfs(root);
      results.push({ entry: root, kind: rootKind, breakages, evaluatedCount: evaluated });
    };

    run(entry, kind);
    while (lazyQueue.length > 0) {
      const next = lazyQueue.shift()!;
      if ((state.get(next) ?? 0) !== 0) continue;
      run(next, 'lazy');
    }
    return results;
  }

  private analyzeBackEdge(from: string, to: string, state: Map<string, EvalState>, path: string[]): EdgeBreakage | null {
    const edge: GraphEdge | undefined = this.graph.out.get(from)?.get(to);
    if (!edge) return null;
    const failing: FailingUsage[] = [];
    let deferredCount = 0;

    for (const record of edge.records) {
      if (record.erased || record.kind === 'dynamic' || record.kind === 'reexport' || record.kind === 'reexport-all' || record.kind === 'side-effect') continue;
      for (const spec of record.specifiers) {
        for (const usage of spec.usages) {
          if (usage.timing === 'type') continue;
          const bindingName = spec.imported === '*' ? usage.member : spec.imported;
          if (bindingName === undefined) continue; // namespace object itself: always available
          const resolved = spec.imported === '*' && record.kind !== 'static' && record.kind !== 'import-equals' && record.kind !== 'require'
            ? null
            : resolveExport(this.graph, to, bindingName, this.exportCache);
          let originPath: string | null;
          let kind: ExportKind;
          let hoisted: boolean;
          if (resolved) {
            originPath = resolved.originPath;
            kind = resolved.record.kind;
            hoisted = resolved.record.hoisted;
          } else {
            // Unknown binding (external re-export or unresolved). Assume it comes from `to`.
            originPath = to;
            kind = 'unknown';
            hoisted = false;
          }
          if (kind === 'type' || kind === 'interface') continue;
          const originStateRaw = originPath ? (state.get(originPath) ?? 0) : 2;
          const originState = originStateRaw === 2 ? 'done' : originStateRaw === 1 ? 'in-progress' : 'not-started';
          if (originState === 'done') continue;
          const bstate = bindingStateFor(kind, hoisted);
          if (bstate === 'hoisted') continue;
          if (usage.timing === 'eager') {
            failing.push({ specifier: spec, usage, originPath, originKind: kind, state: bstate, originState });
          } else {
            deferredCount++;
          }
        }
      }
    }
    if (failing.length === 0 && deferredCount === 0) return null;
    // chain: the full evaluation path from the entry down to `from`; `to` is on it (in progress).
    return { from, to, failing, deferredCount, chain: [...path] };
  }
}

export const evaluateAll = (
  graph: ModuleGraph,
  mainEntries: string[],
  testEntries: string[],
): EntryEvaluation[] => {
  const ev = new Evaluator(graph);
  const out: EntryEvaluation[] = [];
  for (const e of mainEntries) out.push(...ev.evaluateEntry(e, 'main'));
  for (const e of testEntries) out.push(...ev.evaluateEntry(e, 'test'));
  return out;
};
