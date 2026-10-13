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

## Reading the report

Findings are grouped into **problems**: a problem is a cyclic group (files that can all reach each
other). One group usually causes several findings and one change usually fixes all of them, so every
problem starts with its **verified fix** – the fewest imports to change so the group becomes acyclic –
followed by one collapsible row per finding (failing line, call chain, load order, cycle diagram,
fixes). The text report starts with the same "Problems – fix these first" overview.

| Severity | Meaning |
| --- | --- |
| **critical** | A read of an uninitialised binding when the app or a lazy route loads. Crashes. |
| **high** | The same, but only when a spec file is the entry ("works in the app, fails in tests"); Angular DI cycles (NG0200); a value that is silently `undefined` on app load. |
| **medium** | Proven to crash when another file of the cycle is imported first (the group is replayed with every member as the first import), or a *possible* crash that depends on something the analysis cannot prove (a branch, an assumed synchronous callback, a file outside the analysed set). The reason is shown. |
| **low** | One finding per cyclic group that was replayed in every order without a crash. Works, but the next top-level use breaks it. |
| **info** | Type-only cycles. The compiler erases these imports; nothing happens at runtime. |

## How the analysis works

1. **Parse** every file with the TypeScript compiler API (no type-check; ~1 s for 70k lines). Every
   reference to an imported binding is classified as
   *load time* (top-level code, `extends`, decorator arguments such as `@Component({ imports, providers })`,
   static fields, enum initialisers, callbacks of `.map()`/`.forEach()`/`new Promise()`, functions,
   static methods and classes invoked while the module loads),
   *later* (function/method/constructor bodies, instance fields, `inject()`, arrow functions, `forwardRef`),
   or *type* (annotations, `implements`, generics, `import type`). Per top-level function the parser
   also records a *footprint* – what it reads when called – so load-time calls can be followed across
   files.
2. **What the compiler emits** decides which imports exist at runtime: unused and type-only imports
   are erased; Angular constructor parameter types are kept (ngtsc references them in the generated
   factory, including `X | null`); `emitDecoratorMetadata` only adds reads for non-Angular decorators
   (ngtsc strips Angular decorators first); `const enum` imports are erased only without
   `isolatedModules`; type-only `export { T } from` and `import x = require()` are erased like tsc does.
3. **Load-order replay** follows the ES-module algorithm: depth-first in import order, a module body
   runs once all its imports are done or still loading. At that moment every load-time read is
   checked against the declaring file (through barrels and `export *`): `class`/`const`/`let` →
   TDZ `ReferenceError`, `var`/`enum`/`namespace` → `undefined`, `function` declarations → always
   initialised – unless the called function itself reads something that has not run yet. Entries:
   `main.ts`, every lazy `import()` chunk, every spec file in isolation, and every file of each cyclic
   group as a hypothetical first import (proves or refutes order-dependent cycles).
4. **Never guess**: bindings from packages or unresolvable re-exports never produce a certain finding;
   files outside the analysed set are opaque modules whose load *time* is known, so reading their
   re-exports before they load is reported as a possible crash.
5. **Cycles and fix plans**: Tarjan SCCs, shortest cycle per edge plus bounded Johnson enumeration,
   greedy feedback-arc-set per group. A barrel import is rewired to the declaring files (as you would
   fix it) and the plan is only "verified" when the rewired graph is acyclic.
6. **DI graph**: injectables, components, directives, pipes, NgModules and `InjectionToken`s with
   constructor parameters, `inject()` (fields, constructor, parameter defaults, `useFactory`,
   token factories), inherited dependencies, `useClass`/`useExisting`/`deps` (with
   `[new Optional(), new SkipSelf(), X]` flags), root-level providers (`app.config.ts`) and
   component-scoped injectors (a root service cannot see a component's providers).

## Programmatic API

```ts
import { analyze, renderTextReport, renderHtmlReport, toJsonReport } from 'circular-deps-check';

const result = await analyze({ root: '/my/app', entries: ['src/main.ts'] });
for (const f of result.findings) console.log(f.severity, f.title);
```

## Development

```bash
bun test              # unit + end-to-end tests (fixtures/01-04, detection precision suites) + performance test (generated 3k-file project)
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

- A higher-order function from another file that invokes a callback it receives
  (`run(() => A.n)`), and methods called on a fresh instance (`new Svc().get()`), are not followed.
- Footprints only include code that runs directly when a function is called; reads inside branches are
  reported as possible crashes, not certain ones.
- Top-level `await import()` is treated like any dynamic import (a lazy chunk).
- Spec files are replayed with a fresh module registry each (vitest/jest behaviour). Karma loads all
  specs into one registry, where the order of spec files decides which test-only crashes occur.
- Scope analysis is syntactic (parameters and block-level declarations); exotic shadowing may hide a usage.
- Angular `NgModule` remote scoping (NG3003) is not modelled; standalone components are analysed as
  the compiler emits them.
