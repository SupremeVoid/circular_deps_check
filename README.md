# circular-deps-check (`circdeps`)

A circular-dependency checker for large TypeScript / Angular code bases that reports **the cycles that
actually break** and pinpoints **the exact edge, symbol and line** where they break.

Most cycle detectors (madge, dpdm, skott, dependency-cruiser, `import/no-cycle`) print every cycle in
the file graph and leave you with hundreds of entries, most of which are harmless, plus the standard
non-advice "use `import type`". `circdeps` instead answers three questions:

1. **Which cycles crash at load time?** It replays the ECMAScript module evaluation order from your
   entry points (`main.ts`, every lazy route chunk, every `*.spec.ts`) and finds every *eager* read of a
   binding whose module has not finished initialising – the reads that throw
   `ReferenceError: Cannot access 'X' before initialization` or leave `X` undefined
   (`Class extends value undefined`, `Invalid provider … undefined`).
2. **Which cycles are Angular DI cycles?** Services/components that need each other during
   construction (`constructor(private b: B)`, `inject(B)`, `useExisting`, factory `deps`) → NG0200.
3. **Which cycles are order-dependent, deferred-only or purely type-level?** So you can prioritise.

Every finding comes with the evaluation chain, the failing source line, and **graph-verified fix
suggestions** (direct imports instead of barrels, symbol extraction traced through the symbol's own
imports, `forwardRef`, lazy routes, `emitDecoratorMetadata`).

## Install / run

```bash
bun install
bun run src/cli.ts /path/to/angular-project
# or after `bun run build`:
node bin/circdeps.js /path/to/angular-project
```

Reports are written to `./reports/circular-deps.{txt,html,json}`; the terminal shows the critical,
high and medium findings. The HTML report is a single self-contained file (works offline, dark mode).

```
circdeps [root] [options]
  --tsconfig <path>        tsconfig used for path aliases (auto-detected)
  --include <glob>         files to analyze (repeatable, default **/*.{ts,tsx,mts,cts})
  --exclude <glob>         files to skip (repeatable)
  --entry <path|glob>      application entry point(s) (default: src/main.ts)
  --test-entry <glob>      test entry glob(s) (default: **/*.spec.ts)
  --no-tests               skip test entries
  --out <dir>              report directory (default ./reports)
  --format text,html,json  which reports to write
  --fail-on <severity>     exit 1 at this severity or worse (default: high; `none` never fails)
  --max-cycles <n>         cycles enumerated per cyclic group (default 200)
  --verbose / --quiet / --json / --no-color / --no-angular / --emit-decorator-metadata
```

A `circdeps.config.json` in the project root accepts the same keys as the JS API (`include`,
`exclude`, `entries`, `testEntries`, `noTestEntries`, `maxCyclesPerScc`, `reportTypeOnly`, …).

## Severities

| Severity | Meaning |
| --- | --- |
| **critical** | Eager use of an uninitialised binding on the load path from the app entry (or a lazy chunk). Crashes. |
| **high** | Angular DI cycle (NG0200), or a crash that only happens when a spec file is the entry ("works in the app, fails in tests"). |
| **medium** | Order-dependent: an eager use inside the cyclic group that is currently saved by evaluation order. The next import/spec/barrel change flips it. |
| **low** | All uses are deferred (function bodies, methods, instance fields, `inject()`), hoisted functions, or barrel/side-effect only. Works, fragile. |
| **info** | Type-only cycles. TypeScript/esbuild erase these imports; nothing happens at runtime. `import type` changes nothing. |

## How the analysis works

1. **Parse** every file with the TypeScript compiler API (no type-check, no `Program`; ~1 s per
   100k lines). For each imported binding, every reference is classified as
   *eager* (top-level statements, `extends`, decorator arguments such as `@Component({ imports, providers })`,
   static fields, enum initialisers, functions/classes invoked at module load),
   *deferred* (function/method/constructor bodies, instance fields, arrow functions, `forwardRef`),
   or *type* (annotations, `implements`, generics, `import type`). Shadowing, namespace member access,
   re-exports (`export *`, `export { x } from`), dynamic `import()`, `require`, `import =` and
   `emitDecoratorMetadata` (constructor parameter types become values) are handled.
2. **Graph**: imports that are type-only or unused are marked *erased* (exactly like `isolatedModules`
   / esbuild do), dynamic imports become lazy entries, barrels are detected and re-exports resolved to
   the declaring file.
3. **Cycles**: Tarjan SCCs on the runtime graph, shortest cycle through every edge plus bounded
   Johnson enumeration, greedy feedback-arc-set "fix plan" per group (verified acyclic).
4. **Evaluation replay**: depth-first in import order from each entry. On every back edge the tool
   checks each eager usage: is the binding's *declaring* module (after barrels) done, in progress or
   not started, and is the binding a hoisted function (`function` declarations are always initialised),
   a `class`/`const`/`let` (TDZ) or `var`/`enum`/`namespace` (undefined)? Spec files are replayed
   in isolation, so cycles that only bite under vitest/jest/karma are found too.
5. **DI graph**: `@Injectable/@Component/@Directive/@Pipe/@NgModule` classes with constructor
   parameter types, `@Inject(TOKEN)`, `inject(X, { optional, self, skipSelf, host })` in field
   initialisers/constructors, `providers: [{ provide, useClass, useExisting, deps }]`.

## Programmatic API

```ts
import { analyze, renderTextReport, renderHtmlReport, toJsonReport } from 'circular-deps-check';

const result = await analyze({ root: '/my/app', entries: ['src/main.ts'] });
for (const f of result.findings) console.log(f.severity, f.title);
```

## Development

```bash
bun test              # unit + end-to-end tests (fixtures/01-04) + performance test (generated 3k-file project)
bun run typecheck
bun run build         # emits dist/ for the node CLI in bin/
bun run gen:fixtures  # regenerate fixtures/05-large-generated
```

Fixtures under `fixtures/` document every supported pattern: barrels, path aliases, mutual standalone
components, lazy routes, DI cycles, enum/const pairs, hoisted functions, `emitDecoratorMetadata`.
`fixtures/05-large-generated` is a deterministic 3,000-file Angular-style project (seeded generator,
`planted.json` lists the seven planted cycle groups); the perf test analyses it, including 557 spec
entries and 10 lazy chunks, in about one second on a laptop.

## Known limitations

- Call chains across files are not traced: a hoisted function that is *called* at load time in
  another file and touches an uninitialised binding inside its body is reported as deferred.
- Scope analysis is syntactic (parameters, `let/const/var/function/class` in enclosing blocks); exotic
  shadowing may miss a usage.
- Angular `NgModule` remote scoping (NG3003) is not modelled; standalone components are analysed exactly
  as the compiler emits them (direct references unless `forwardRef` is used).
