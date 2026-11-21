# circular-deps-check (`circdeps`)

Finds the import cycles in a TypeScript / Angular project that **actually break** – and shows the
exact line, the load order that leads to it, and a fix that has already been tried out for you.

<p align="center">
  <a href="https://supremevoid.github.io/circular_deps_check/sample-report/"><img src="docs/img/report-overview.png" width="760" alt="HTML report of the sample shop app: four load-time crashes, each group with its verified fix"></a>
</p>

**[Check this sample report →](https://supremevoid.github.io/circular_deps_check/sample-report/)** –
the live report of a small shop app (65 components) with cycles of 2 to 8 files. Hover the arrows.

## Quick start

```bash
bun install
bun run src/cli.ts /path/to/your/project
```

Then open `reports/circular-deps.html`. The terminal prints what is broken (or may be) and one line
about the rest; `reports/` also gets a `.txt` and a `.json` version.

Without Bun at run time: `bun run build` once, then `node bin/circdeps.js /path/to/your/project`.

In CI the command exits with code 1 when something is broken (see `--fail-on`).

## What it tells you

| Severity | Meaning | What to do |
| --- | --- | --- |
| **critical** | Crashes when the app or a lazy route loads. | Fix. |
| **high** | Crashes when a spec file loads; Angular DI cycle (NG0200); a value that is silently `undefined` on app load. | Fix. |
| **medium** | *Possible* crash on a real load path: the read is reached, but it sits in a branch or callback the tool cannot prove runs. The reason is shown. | Check. |
| **low** | *Order-dependent.* Works in every load order your project uses today; would break if another file of the cycle were imported first. One entry per group of files. | Nothing now – good to know before you reorder imports there. |
| **info** | A cycle that cannot crash (the imports are only used inside functions, or only as types). | Nothing. |

Severity says how real a problem is **today**. A cycle that works in every current load order is
never more than low.

## The report

Files that can all reach each other form a *group*. One group usually causes several findings and
one change usually fixes all of them, so each group starts with its **fix** and lists the findings
below it.

### The code behind every arrow

Open a finding to see the failing line, the load order from your entry point, and the cycle as a
diagram. Hover an arrow to see the import statement and the lines that use it – the failing read
is marked. Click the arrow to keep the popup open; the line numbers then open the file in VS Code.

<p align="center">
  <img src="docs/img/report-code-popup.png" width="720" alt="A cycle of eight files that only crashes when one spec loads: load order, diagram, and a popup with the import statement and the failing line">
</p>

### What happens after the fix

Changing an import changes the order in which files load, so a line that was fine can become the
next crash. To take that surprise out, every fix is replayed: your entry points are loaded again
with the fix applied one change at a time.

```
✔ fix (verified, 2 imports):
  ✂ orders/order-list.component.ts → shared/index.ts { formatDate }  import { formatDate } from '../../shared/util/format' instead of the barrel
      then: next crash – shared/widgets/table-presets.ts:4 reads `OrderRowComponent` too early when orders.routes.ts loads – today only order-dependent, C10
  ✂ orders/order-row.component.ts → shared/index.ts { ROW_PRESET }  …
      then: C2 no longer crashes
  replayed 1 entry point with all 2 imports changed: no crash left in this group, none surfaces elsewhere
```

A "next crash" line names what would surface if you stopped after that step.

### Order-dependent cycles

A low finding lists the reads that depend on the import order, which file would have to be imported
first to break them, and why that does not happen today.

<p align="center">
  <img src="docs/img/report-order-dependent.png" width="720" alt="Order-dependent finding: why nothing breaks today and which reads would break under another import order">
</p>

## Options

```
circdeps [root] [options]
```

| Option | Purpose | Default |
| --- | --- | --- |
| `--entry <path\|glob>` | App entry point(s), repeatable | `src/main.ts` |
| `--test-entry <glob>` | Spec files, each loaded on its own | `**/*.spec.ts` |
| `--no-tests` | Ignore spec files | |
| `--include` / `--exclude <glob>` | Files to analyse, repeatable | all `.ts` files |
| `--tsconfig <path>` | tsconfig used for path aliases | auto-detected |
| `--out <dir>` | Where the reports go | `./reports` |
| `--display-root <text>` | Show this instead of the project path on your machine (for reports you publish or attach in CI) | |
| `--format text,html,json` | Which reports to write | all three |
| `--fail-on <severity>` | Exit 1 at this severity or worse (`none` never fails) | `high` |
| `--no-fix-preview` | Skip replaying the fixes (faster) | |
| `--verbose` / `--quiet` | Print everything / only the summary | |
| `--json` | Print the JSON report to stdout | |
| `--no-angular` | Skip the Angular DI analysis | |

Run `circdeps --help` for the full list. The same settings can live in a `circdeps.config.json`
in the project root (`entries`, `testEntries`, `include`, `exclude`, `fixPreview`, …).

Use it from code:

```ts
import { analyze } from 'circular-deps-check';

const result = await analyze({ root: '/my/app', entries: ['src/main.ts'] });
for (const f of result.findings) console.log(f.severity, f.title);
```

## How it works

An import cycle only breaks when a file *reads* something from a file that has not finished loading.
So instead of listing cycles, the tool loads your project the way the browser or the test runner
would – on paper:

1. **Read every file** and note, for each import, whether it is used while the file loads (top-level
   code, `extends`, decorator arguments like `@Component({ imports })`, static fields), only later
   (inside functions, constructors, `inject()`), or only as a type. It follows what the compiler
   emits: type-only imports disappear, Angular constructor parameter types stay.
2. **Replay the load order** from every real starting point: `main.ts`, each lazy route on its own
   (as if a user opened that URL directly), and each spec file on its own. Every load-time read of
   something not yet initialised is a finding – with the line, the chain of files and the cycle.
   Calls into other files at load time are followed.
3. **Replay each group once more with every file imported first.** Reads that only fail there are
   the order-dependent ones (low).
4. **Find Angular DI cycles**: services and components that need each other while being constructed.
5. **Plan and replay a fix** for every group: the fewest imports to change so the group is no longer
   cyclic, then the entry points again with those changes applied.

Nothing is guessed: what cannot be proven is reported as *possible* with the reason, or not at all.

## Good to know

- Spec files are loaded one at a time with nothing else loaded, as Vitest and Jest do. Karma loads
  all specs together, where a spec that fails alone may pass. Test setup files are not replayed.
- A read inside a branch (`if`, `?:`, `&&`, `??`, after an early `return`) or in a callback of an
  array that may be empty is reported as *possible*, even if it always runs in practice.
- Callbacks handed to your own functions (`once(() => A)`), `fn.call()` and methods called on a
  fresh instance (`new Svc().get()`) are not followed, so a load-time read hidden there is missed.
- The fix replay shows the plan as written: the listed imports are gone or point at the declaring
  file. A fix that only defers a read (`forwardRef`, moving the access into a function) keeps the
  load order and helps only when that read is the failing one.
- Top-level `await import()` is treated like any lazy import. Angular `NgModule` remote scoping
  (NG3003) is not modelled.

## Development

```bash
bun test              # unit and end-to-end tests, including a generated 3,000-file project
bun run typecheck
bun run build         # emits dist/ for the node CLI in bin/
bun run gen:fixtures  # regenerate fixtures/05-large-generated
```

`fixtures/` holds one small project per pattern (barrels, path aliases, lazy routes, DI cycles,
`emitDecoratorMetadata`, a fix that changes the load order) and `07-shop-app`, a shop with 65
components and every kind of finding. The screenshots and the sample report come from that app;
`bun run sample:report` rebuilds `docs/sample-report/`, which GitHub Pages serves. Detection
changes are checked against real ES-module execution; `tests/audit.test.ts` keeps the cases that
found a mistake.
