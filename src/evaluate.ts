/**
 * ES module evaluation-order simulation.
 *
 * ESM links the whole module graph first (all bindings exist, function declarations are already
 * initialised) and then evaluates modules depth-first in the order of their module requests
 * (`import` and `export … from` declarations, in source order). A module's body runs only after
 * every requested module is either done or still in progress (= an ancestor on the current
 * evaluation path, i.e. a cycle). While a body has not run, its `class`/`const`/`let` bindings are
 * in the temporal dead zone (ReferenceError) and its `var`/`enum`/`namespace` bindings are
 * `undefined` (that is also what bundlers such as esbuild produce for hoisted declarations).
 *
 * The evaluator replays exactly that order and, at the moment each module body runs, checks every
 * eager read of an imported binding – following barrels to the declaring module and following
 * load-time calls into other modules' functions – against the evaluation state at that moment.
 */
import type {
  BindingState,
  CallStep,
  EdgeBreakage,
  EntryEvaluation,
  EntryKind,
  ExportKind,
  FailingUsage,
  ImportRecord,
  ImportSpecifierInfo,
  ModuleGraph,
  Usage,
} from './types.js';
import { resolveExport, type ResolvedExport } from './graph.js';

type EvalState = 0 | 1 | 2; // unvisited | in progress | done

const MAX_CALL_DEPTH = 8;

export const bindingStateFor = (kind: ExportKind, hoisted: boolean): BindingState => {
  if (hoisted || kind === 'function') return 'hoisted';
  if (kind === 'var' || kind === 'enum' || kind === 'namespace') return 'undefined';
  return 'tdz';
};

const isTypeKind = (k: ExportKind): boolean => k === 'type' || k === 'interface';

/** `export * as ns from './x'` – a namespace object exists from link time on. */
const isNamespaceReexport = (r: ResolvedExport): boolean => r.record.importedName === '*' && r.record.from !== undefined;

interface BodyCheck {
  /** Module whose body is running. */
  module: string;
  /** Evaluation path from the root to `module` (inclusive). */
  path: string[];
  state: Map<string, EvalState>;
}

export class Evaluator {
  /** Ordered runtime module requests per module (deduplicated). */
  private readonly requests = new Map<string, string[]>();
  private readonly dynamicTargets = new Map<string, string[]>();
  private readonly exportCache = new Map<string, ResolvedExport | null>();

  constructor(private readonly graph: ModuleGraph) {
    for (const mod of graph.modules.values()) {
      const list: string[] = [];
      const dyn: string[] = [];
      const sorted = [...mod.imports].sort((a, b) => a.line - b.line || a.column - b.column);
      for (const record of sorted) {
        const to = record.resolvedPath;
        if (!to || record.external || !graph.modules.has(to) || to === mod.path) continue;
        if (record.kind === 'dynamic') {
          dyn.push(to);
          continue;
        }
        if (record.erased) continue;
        if (!list.includes(to)) list.push(to);
      }
      this.requests.set(mod.path, list);
      this.dynamicTargets.set(mod.path, dyn);
    }
  }

  /**
   * Evaluate starting at `entry`. For app/test entries, dynamic `import()` targets discovered on
   * the way are evaluated afterwards as lazy roots sharing the same state (already loaded modules
   * are not re-run). Hypothetical entries (used to prove order-dependent cycles) skip lazy roots.
   */
  evaluateEntry(entry: string, kind: EntryKind): EntryEvaluation[] {
    const state = new Map<string, EvalState>();
    const results: EntryEvaluation[] = [];
    const lazyQueue: string[] = [];
    const queued = new Set<string>([entry]);
    const followLazy = kind !== 'hypothetical';

    const run = (root: string, rootKind: EntryKind): void => {
      const byEdge = new Map<string, EdgeBreakage>();
      let evaluated = 0;
      const stack: { node: string; i: number }[] = [];
      const path: string[] = [];
      const enter = (n: string): void => {
        state.set(n, 1);
        stack.push({ node: n, i: 0 });
        path.push(n);
        if (!followLazy) return;
        for (const d of this.dynamicTargets.get(n) ?? []) {
          if (!queued.has(d)) {
            queued.add(d);
            lazyQueue.push(d);
          }
        }
      };
      enter(root);
      while (stack.length > 0) {
        const frame = stack[stack.length - 1]!;
        const reqs = this.requests.get(frame.node) ?? [];
        if (frame.i < reqs.length) {
          const to = reqs[frame.i++]!;
          if ((state.get(to) ?? 0) === 0) enter(to);
          continue;
        }
        // All requests are done or in progress: the module body runs now.
        this.checkBody({ module: frame.node, path: [...path], state }, byEdge);
        stack.pop();
        path.pop();
        state.set(frame.node, 2);
        evaluated++;
      }
      results.push({ entry: root, kind: rootKind, breakages: [...byEdge.values()], evaluatedCount: evaluated });
    };

    if ((state.get(entry) ?? 0) === 0) run(entry, kind);
    while (lazyQueue.length > 0) {
      const next = lazyQueue.shift()!;
      if ((state.get(next) ?? 0) !== 0) continue;
      run(next, 'lazy');
    }
    return results;
  }

  /** Is a binding declared at `declLine` in `origin` initialised while `ctx.module`'s body is at `atLine`? */
  private initialised(origin: string, declLine: number, kind: ExportKind, hoisted: boolean, atLine: number, ctx: BodyCheck): boolean {
    if (hoisted || kind === 'function') return true;
    const st = ctx.state.get(origin) ?? 0;
    if (st === 2) return true;
    // The running module itself (reached back through a barrel): earlier declarations already ran.
    if (origin === ctx.module) return declLine < atLine;
    return false;
  }

  private originState(origin: string, ctx: BodyCheck): FailingUsage['originState'] {
    const st = ctx.state.get(origin) ?? 0;
    return st === 2 ? 'done' : st === 1 ? 'in-progress' : 'not-started';
  }

  private checkBody(ctx: BodyCheck, byEdge: Map<string, EdgeBreakage>): void {
    const mod = this.graph.modules.get(ctx.module);
    if (!mod) return;
    for (const record of mod.imports) {
      const to = record.resolvedPath;
      if (!to || record.external || record.erased || !this.graph.modules.has(to) || to === ctx.module) continue;
      if (record.kind !== 'static' && record.kind !== 'import-equals') continue;
      for (const spec of record.specifiers) {
        for (const usage of spec.usages) {
          if (usage.timing === 'type') continue;
          const member = spec.imported === '*' ? usage.member : spec.imported;
          if (member === undefined) continue; // namespace object itself exists from link time
          // `Object.keys(ns)` / `{ ...ns }` read every exported binding.
          const names = member === '*' ? this.allExportNames(to) : [member];
          for (const name of names) {
            const resolved = resolveExport(this.graph, to, name, this.exportCache);
            // Unresolvable (external re-export, parser gap): never guess – no finding.
            if (!resolved || isTypeKind(resolved.record.kind) || isNamespaceReexport(resolved)) continue;
            const { originPath, record: exp } = resolved;
            const failing: FailingUsage[] = [];
            if (!this.initialised(originPath, exp.line, exp.kind, exp.hoisted, usage.line, ctx)) {
              if (usage.timing === 'eager') {
                failing.push({
                  specifier: spec,
                  usage,
                  binding: name,
                  originPath,
                  originKind: exp.kind,
                  state: bindingStateFor(exp.kind, exp.hoisted),
                  originState: this.originState(originPath, ctx),
                });
              } else {
                this.edge(byEdge, ctx, record).deferredCount++;
              }
            } else if (usage.timing === 'eager' && usage.call) {
              // A load-time call into another module: what the called function reads must be ready too.
              // `Imported.staticMethod()` follows the static method.
              const local = exp.localName ?? name;
              const fn = spec.imported !== '*' && usage.access && usage.access !== '*' ? `${local}.${usage.access}` : local;
              this.followCall(originPath, fn, usage, spec, ctx, [], new Set(), failing);
            }
            if (failing.length > 0) {
              this.edge(byEdge, ctx, record).failing.push(...failing);
              if (member === '*') break; // one uninitialised binding is enough to make the enumeration throw
            }
          }
        }
      }
    }
  }

  private edge(byEdge: Map<string, EdgeBreakage>, ctx: BodyCheck, record: ImportRecord): EdgeBreakage {
    const key = record.resolvedPath!;
    let b = byEdge.get(`${ctx.module}\0${key}`);
    if (!b) {
      b = { from: ctx.module, to: key, failing: [], deferredCount: 0, chain: ctx.path };
      byEdge.set(`${ctx.module}\0${key}`, b);
    }
    return b;
  }

  /**
   * `fn` (declared in `origin`) is called while `ctx.module`'s body runs. Check every module-level
   * binding the function reads directly (its own file's and imported ones) and follow further calls.
   */
  private followCall(
    origin: string,
    fn: string,
    usage: Usage,
    spec: ImportSpecifierInfo,
    ctx: BodyCheck,
    steps: CallStep[],
    visited: Set<string>,
    out: FailingUsage[],
  ): void {
    if (steps.length >= MAX_CALL_DEPTH) return;
    const key = `${origin}#${fn}`;
    if (visited.has(key)) return;
    visited.add(key);
    const omod = this.graph.modules.get(origin);
    const fp = omod?.footprints[fn];
    if (!omod || !fp) return;

    const fail = (binding: string, bindingOrigin: string, kind: ExportKind, hoisted: boolean, line: number): void => {
      out.push({
        specifier: spec,
        usage,
        binding,
        via: [...steps, { fn, path: origin, line }],
        originPath: bindingOrigin,
        originKind: kind,
        state: bindingStateFor(kind, hoisted),
        originState: this.originState(bindingOrigin, ctx),
      });
    };

    for (const loc of fp.locals) {
      const decl = omod.topLevel[loc.name];
      if (!decl || isTypeKind(decl.kind)) continue;
      if (!this.initialised(origin, decl.line, decl.kind, false, usage.line, ctx)) {
        fail(loc.name, origin, decl.kind, false, loc.line);
      } else if (loc.call) {
        this.followCall(origin, loc.member ? `${loc.name}.${loc.member}` : loc.name, usage, spec, ctx, [...steps, { fn, path: origin, line: loc.line }], visited, out);
      }
    }

    for (const imp of fp.imports) {
      const found = this.findBinding(omod.imports, imp.local);
      if (!found) continue;
      const { record, spec: ospec } = found;
      const to = record.resolvedPath;
      if (!to || record.external || record.erased || record.kind === 'dynamic' || !this.graph.modules.has(to)) continue;
      const name = ospec.imported === '*' ? imp.member : ospec.imported;
      if (name === undefined) continue;
      const resolved = resolveExport(this.graph, to, name, this.exportCache);
      if (!resolved || isTypeKind(resolved.record.kind) || isNamespaceReexport(resolved)) continue;
      const exp = resolved.record;
      if (!this.initialised(resolved.originPath, exp.line, exp.kind, exp.hoisted, usage.line, ctx)) {
        fail(name, resolved.originPath, exp.kind, exp.hoisted, imp.line);
      } else if (imp.call) {
        const local = exp.localName ?? name;
        const next = ospec.imported !== '*' && imp.member ? `${local}.${imp.member}` : local;
        this.followCall(resolved.originPath, next, usage, spec, ctx, [...steps, { fn, path: origin, line: imp.line }], visited, out);
      }
    }
  }

  /** Every name exported by `path`, including names reached through `export *` (inside the analysed set). */
  private allExportNames(path: string, seen = new Set<string>()): string[] {
    if (seen.has(path)) return [];
    seen.add(path);
    const mod = this.graph.modules.get(path);
    if (!mod) return [];
    const names = new Set(mod.exports.map((e) => e.name));
    for (const star of mod.exportStar) if (star) for (const n of this.allExportNames(star, seen)) if (n !== 'default') names.add(n);
    return [...names];
  }

  private findBinding(records: ImportRecord[], local: string): { record: ImportRecord; spec: ImportSpecifierInfo } | null {
    for (const record of records) {
      for (const spec of record.specifiers) if (spec.local === local) return { record, spec };
    }
    return null;
  }
}

export const evaluateAll = (graph: ModuleGraph, mainEntries: string[], testEntries: string[]): EntryEvaluation[] => {
  const ev = new Evaluator(graph);
  const out: EntryEvaluation[] = [];
  for (const e of mainEntries) out.push(...ev.evaluateEntry(e, 'main'));
  for (const e of testEntries) out.push(...ev.evaluateEntry(e, 'test'));
  return out;
};

/**
 * Replay the load order once per file of each cyclic group, as if that file were the first of the
 * group to be imported (by a new spec, a new feature, a reordered barrel …). Within a strongly
 * connected group the entry file alone determines the evaluation order, so this enumerates every
 * reachable order and proves whether a cycle can crash at all.
 */
export const evaluateHypothetical = (graph: ModuleGraph, groups: string[][]): EntryEvaluation[] => {
  const ev = new Evaluator(graph);
  const out: EntryEvaluation[] = [];
  for (const group of groups) for (const node of group) out.push(...ev.evaluateEntry(node, 'hypothetical'));
  return out;
};
