import type { AnalysisResult, Finding, FixPlan, PreviewFailure, Severity } from '../types.js';
import { c } from '../util/ansi.js';
import { relativeTo } from '../util/paths.js';
import { countBySeverity, severityRank } from '../analyze.js';

export interface TextReportOptions {
  /** Text shown instead of the absolute project path. */
  displayRoot?: string;
  /** Print low/info findings in full. */
  verbose?: boolean;
  /** Only print the summary block. */
  quiet?: boolean;
  maxPerSeverity?: number;
  /** Path of the HTML report to mention at the end. */
  htmlPath?: string;
}

const SEV_LABEL: Record<Severity, (s: string) => string> = {
  critical: (s) => c.bold(c.red(s)),
  high: (s) => c.red(s),
  medium: (s) => c.yellow(s),
  low: (s) => c.cyan(s),
  info: (s) => c.gray(s),
};

const SEV_ICON: Record<Severity, string> = { critical: '✖', high: '✖', medium: '▲', low: '○', info: '·' };

const fmt = (n: number): string => n.toLocaleString('en-US');

const usageTag = (u: string): string => {
  switch (u) {
    case 'eager':
      return c.red('eager');
    case 'deferred':
      return c.yellow('deferred');
    case 'type':
      return c.gray('type-only');
    default:
      return c.gray('no binding use');
  }
};

export const renderTextReport = (result: AnalysisResult, opts: TextReportOptions = {}): string => {
  const rel = (p: string): string => relativeTo(result.root, p);
  const lines: string[] = [];
  const out = (s = ''): void => {
    lines.push(s);
  };
  const { stats } = result;
  const counts = countBySeverity(result.findings);

  out(c.bold(`circular-deps-check`) + c.dim(`  ${opts.displayRoot ?? result.root}`));
  out(
    c.dim(
      `Scanned ${fmt(stats.files)} files (${fmt(stats.loc)} lines) · ${fmt(stats.edges)} import edges · ${fmt(stats.runtimeEdges)} runtime · ${fmt(stats.erasedEdges)} erased (type-only) · ${fmt(stats.dynamicEdges)} dynamic · ${stats.durationMs} ms`,
    ),
  );
  const mainEntries = result.options.entries;
  const lazy = result.entries.filter((e) => e.kind === 'lazy').length;
  const tests = result.options.testEntries.length;
  out(
    c.dim(
      `Entries: ${mainEntries.length > 0 ? mainEntries.join(', ') : c.yellow('none found (pass --entry src/main.ts)')}${lazy ? ` (+${lazy} lazy chunks)` : ''}${tests ? ` · ${fmt(tests)} test entries` : ''}${result.options.emitDecoratorMetadata ? ' · emitDecoratorMetadata: on' : ''}`,
    ),
  );
  if (stats.unresolved > 0) out(c.dim(`Unresolved imports: ${stats.unresolved} (see JSON report)`));
  out();

  out(c.bold('Summary'));
  const row = (sev: Severity, label: string): void => {
    const n = counts[sev];
    const text = `  ${SEV_ICON[sev]} ${String(n).padStart(4)} ${sev.toUpperCase().padEnd(9)} ${label}`;
    out(n > 0 ? SEV_LABEL[sev](text) : c.dim(text));
  };
  row('critical', 'crash when the app or a lazy route loads');
  row('high', 'crash only when a spec is the entry, Angular DI cycles (NG0200)');
  row('medium', 'possible crash on a real load path (cannot be proven either way)');
  row('low', 'works in every current load order, breaks under another one');
  row('info', 'cycles that cannot crash: deferred-only or type-only (no action)');
  out();
  if (stats.sccs === 0) {
    out(c.green('  No runtime import cycles found.'));
  } else {
    const largest = [...result.sccs].sort((a, b) => b.nodes.length - a.nodes.length)[0]!;
    out(
      `  ${stats.sccs} cyclic group${stats.sccs === 1 ? '' : 's'} containing ${fmt(stats.cyclicFiles)} files (${fmt(stats.cycles)} cycles enumerated). Largest group: #${largest.id} with ${largest.nodes.length} files${largest.barrels.length ? `, ${largest.barrels.length} barrel${largest.barrels.length === 1 ? '' : 's'} (${largest.barrels.slice(0, 3).map(rel).join(', ')}${largest.barrels.length > 3 ? ', …' : ''})` : ''}.`,
    );
  }
  out();

  // Problems: one line per cyclic group with its verified fix – usually one change fixes many findings.
  const groupFindings = new Map<number, Finding[]>();
  for (const f of result.findings) {
    if (f.kind === 'di-cycle' || f.kind === 'type-only-cycle') continue;
    groupFindings.set(f.sccId, [...(groupFindings.get(f.sccId) ?? []), f]);
  }
  const worstOf = (list: Finding[]): Severity => list.reduce<Severity>((w, f) => (severityRank(f.severity) < severityRank(w) ? f.severity : w), 'info');
  const sortedGroups = [...groupFindings.entries()].sort((a, b) => severityRank(worstOf(a[1])) - severityRank(worstOf(b[1])) || b[1].length - a[1].length || a[0] - b[0]);
  // Something is (or may be) broken today vs. groups that merely depend on the import order.
  const problemGroups = sortedGroups.filter(([, list]) => severityRank(worstOf(list)) <= severityRank('medium'));
  const fragileGroups = sortedGroups.filter(([, list]) => worstOf(list) === 'low');
  const harmlessGroups = sortedGroups.filter(([, list]) => worstOf(list) === 'info');
  const groupLine = ([id, list]: [number, Finding[]]): void => {
    const scc = result.sccs.find((x) => x.id === id);
    const plan = result.fixPlans.find((p) => p.sccId === id);
    const worst = worstOf(list);
    const counts2 = (['critical', 'high', 'medium', 'low', 'info'] as Severity[]).filter((sv) => list.some((f) => f.severity === sv)).map((sv) => `${list.filter((f) => f.severity === sv).length} ${sv}`).join(', ');
    out(`  ${SEV_LABEL[worst](SEV_ICON[worst])} Group #${id}: ${scc?.nodes.length ?? '?'} files – ${counts2} ${c.dim(`(${list.map((f) => f.id).join(', ')})`)}`);
    if (plan && plan.cuts.length > 0) renderPlan(plan, rel, out);
  };
  const di = result.findings.filter((f) => f.kind === 'di-cycle');
  if (problemGroups.length > 0 || di.length > 0) {
    out(c.bold('Problems – fix these first'));
    const cap = opts.quiet ? 10 : 30;
    problemGroups.slice(0, cap).forEach(groupLine);
    if (problemGroups.length > cap) out(c.dim(`  … ${problemGroups.length - cap} more groups in the HTML report`));
    if (di.length > 0) {
      const worstDi = worstOf(di);
      out(`  ${SEV_LABEL[worstDi](SEV_ICON[worstDi])} ${di.length} Angular DI cycle${di.length === 1 ? '' : 's'} ${c.dim(`(${di.map((f) => f.id).join(', ')})`)}`);
    }
    out();
  }
  if (fragileGroups.length > 0) {
    const reads = fragileGroups.reduce((n, [, list]) => n + list.reduce((m, f) => m + f.failures.length, 0), 0);
    out(c.bold('Not broken today – order-dependent'));
    out(c.dim(`  ${fragileGroups.length} group${fragileGroups.length === 1 ? '' : 's'} with ${reads} load-time read${reads === 1 ? ' that only works' : 's that only work'} in today's import order. Nothing to fix now; untangle when you touch them.`));
    if (opts.verbose) fragileGroups.slice(0, 30).forEach(groupLine);
    out();
  }
  if (harmlessGroups.length > 0 && opts.verbose) {
    out(c.bold('Cycles that cannot crash'));
    out(c.dim(`  ${harmlessGroups.length} group${harmlessGroups.length === 1 ? '' : 's'}: ${harmlessGroups.slice(0, 12).map(([id, list]) => `#${id} (${list.map((f) => f.id).join(', ')})`).join(', ')}${harmlessGroups.length > 12 ? ', …' : ''}`));
    out();
  }
  if (opts.quiet) return lines.join('\n');

  const max = opts.maxPerSeverity ?? 40;
  const groups: Severity[] = opts.verbose ? ['critical', 'high', 'medium', 'low', 'info'] : ['critical', 'high', 'medium'];
  for (const sev of groups) {
    const list = result.findings.filter((f) => f.severity === sev);
    if (list.length === 0) continue;
    out(c.bold(SEV_LABEL[sev](`━━ ${sev.toUpperCase()} (${list.length}) ${'━'.repeat(Math.max(0, 60 - sev.length))}`)));
    out();
    for (const f of list.slice(0, max)) {
      renderFinding(f, result, out);
      out();
    }
    if (list.length > max) out(c.dim(`  … ${list.length - max} more ${sev} findings (see HTML/JSON report)`));
    out();
  }
  if (!opts.verbose && (counts.low > 0 || counts.info > 0)) {
    out(c.dim(`  ${counts.low} low and ${counts.info} info findings hidden – run with --verbose or open the HTML report.`));
    out();
  }

  if (opts.htmlPath) out(c.dim(`Full interactive report: ${opts.htmlPath}`));
  return lines.join('\n');
};

const knownText = (x: PreviewFailure): string =>
  !x.knownAs ? '' : x.knownKind === 'latent-cycle' ? ` – today only order-dependent, ${x.knownAs}` : x.knownKind === 'test-break' ? ` – today only in specs, ${x.knownAs}` : ` – see ${x.knownAs}`;

const previewRef = (x: PreviewFailure, rel: (p: string) => string): string =>
  `${rel(x.from)}:${x.line} reads \`${x.binding}\` too early ${x.entryKind === 'test' ? `in ${rel(x.entry)}` : x.entryKind === 'lazy' ? `when ${rel(x.entry)} loads` : 'on app load'}${x.uncertain ? ' (possible)' : ''}${knownText(x)}`;

/** A group's fix plan, each cut followed by what a replay of the entry points shows once it is applied. */
const renderPlan = (plan: FixPlan, rel: (p: string) => string, out: (s?: string) => void): void => {
  const n = plan.cuts.length;
  out(`      ${plan.verified ? c.green(`✔ fix (verified, ${n === 1 ? '1 import' : `${n} imports`}):`) : c.yellow('suggested cuts (not sufficient):')}`);
  const steps = plan.preview?.simulated ? plan.preview.steps : [];
  let resolvedBefore = new Set<string>();
  plan.cuts.slice(0, 6).forEach((cut, i) => {
    const syms = cut.symbols.length > 0 ? ` ${c.dim(`{ ${cut.symbols.slice(0, 4).join(', ')}${cut.symbols.length > 4 ? ', …' : ''} }`)}` : '';
    out(`        ✂ ${rel(cut.from)} ${c.dim('→')} ${rel(cut.to)}${syms}  ${c.dim(cut.reason)}`);
    const step = steps[i];
    if (!step) return;
    const newly = step.resolved.filter((id) => !resolvedBefore.has(id));
    resolvedBefore = new Set(step.resolved);
    if (newly.length > 0) out(c.dim(`            then: ${newly.join(', ')} no longer crash${newly.length === 1 ? 'es' : ''}`));
    for (const x of step.exposed.slice(0, 3)) out(c.yellow(`            then: next crash – ${previewRef(x, rel)}`));
    if (step.exposed.length > 3) out(c.yellow(`            … and ${step.exposed.length - 3} more reads surface`));
  });
  if (n > 6) out(c.dim(`        … ${n - 6} more`));
  const last = steps[n - 1];
  if (plan.preview?.simulated && last) {
    const entries = `${plan.preview.entries} entry point${plan.preview.entries === 1 ? '' : 's'}${plan.preview.skippedTests ? ` (app only, ${plan.preview.skippedTests} specs not replayed)` : ''}`;
    const what = n === 1 ? 'this import gone' : `all ${n} imports changed`;
    const left = last.remaining.length + last.exposed.length;
    if (left === 0) out(c.green(`        replayed ${entries} with ${what}: ${plan.preview.skippedTests ? 'no app-load crash left' : 'no crash left'} in this group, none surfaces elsewhere`));
    else out(c.yellow(`        replayed ${entries} with ${what}: ${left} read${left === 1 ? ' still fails' : 's still fail'} – e.g. ${previewRef((last.exposed[0] ?? last.remaining[0])!, rel)}`));
  } else if (plan.preview && !plan.preview.simulated) {
    out(c.dim(`        not replayed: ${plan.preview.reason}`));
  }
};

const renderFinding = (f: Finding, result: AnalysisResult, out: (s?: string) => void): void => {
  const rel = (p: string): string => relativeTo(result.root, p);
  out(`${SEV_LABEL[f.severity](`[${f.id}] ${f.severity.toUpperCase()}`)}  ${c.bold(f.title)}`);
  out(`  ${f.summary}`);

  if (f.kind === 'latent-cycle') {
    out();
    out(`  ${c.bold(`Reads that depend on the import order (${f.failures.length})`)}`);
    for (const fp of f.failures.slice(0, 8)) {
      out(`    ${c.underline(`${rel(fp.from)}:${fp.usage.line}:${fp.usage.column}`)}  ${c.dim(fp.usage.snippet)}`);
      const trigger = fp.entries[0];
      const more = (fp.triggerCount ?? fp.entries.length) - 1;
      const via = fp.via && fp.via.length > 0 ? `calls \`${fp.symbol}()\` → ${fp.via.map((v) => `${v.fn}() (${rel(v.path)}:${v.line})`).join(' → ')} reads ` : '';
      out(`      ↳ ${via}\`${fp.binding}\` (${fp.originKind} in ${rel(fp.originPath ?? fp.to)}) is not initialised if ${trigger ? rel(trigger.entry) : '?'} is imported first${more > 0 ? ` (or ${more} other file${more === 1 ? '' : 's'} of the group)` : ''}`);
      if (fp.uncertain) out(c.yellow(`      ↳ not certain: ${fp.uncertain}`));
    }
    if (f.failures.length > 8) out(c.dim(`    … ${f.failures.length - 8} more reads (see HTML/JSON report)`));
    if (f.enteredThrough && f.enteredThrough.length > 0) {
      out();
      out(`  ${c.bold('Entered today through')} ${c.dim('(safe orders)')}`);
      for (const g of f.enteredThrough.slice(0, 5)) {
        const who = [g.main ? 'app start' : '', g.lazy ? `${g.lazy} lazy chunk${g.lazy === 1 ? '' : 's'}` : '', g.test ? `${g.test} spec${g.test === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
        out(`    ${rel(g.file)}  ${c.dim(who)}`);
      }
      if (f.enteredThrough.length > 5) out(c.dim(`    … ${f.enteredThrough.length - 5} more files`));
    }
  } else if (f.failures.length > 0) {
    const first = f.failures[0]!;
    out();
    out(`  ${c.bold('Point of failure')}`);
    for (const fp of f.failures.slice(0, 4)) {
      out(`    ${c.underline(`${rel(fp.from)}:${fp.usage.line}:${fp.usage.column}`)}  ${c.dim(fp.usage.snippet)}`);
      if (fp.via && fp.via.length > 0) {
        out(`      ↳ calls \`${fp.symbol}()\`: ${fp.via.map((v) => `${v.fn}() (${rel(v.path)}:${v.line})`).join(' → ')} reads \`${fp.binding}\``);
      }
      out(`      ↳ \`${fp.binding}\` (${fp.originKind}) in ${rel(fp.originPath ?? fp.to)} is ${fp.state === 'tdz' ? 'still loading → TDZ ReferenceError' : 'not evaluated yet → undefined'}; context: ${fp.usage.context}`);
      if (fp.uncertain) out(c.yellow(`      ↳ not certain: ${fp.uncertain}`));
    }
    if (f.failures.length > 4) out(c.dim(`    … ${f.failures.length - 4} more reads on this import`));
    const entries = new Map<string, { kind: string; chain: string[] }>();
    for (const fp of f.failures) for (const e of fp.entries) if (!entries.has(e.entry)) entries.set(e.entry, e);
    const app = [...entries.entries()].filter(([, e]) => e.kind === 'main' || e.kind === 'lazy');
    const test = [...entries.entries()].filter(([, e]) => e.kind === 'test');
    const ancestor = first.originPath ?? first.to;
    const chainText = (chain: string[]): string =>
      chain
        .map((p, i) => (p === ancestor ? c.yellow(`${rel(p)} ⟳`) : i === chain.length - 1 ? c.red(`${rel(p)} ✖`) : rel(p)))
        .join(c.dim(' → '));
    if (app.length > 0) {
      const [entry, info] = app[0]!;
      out();
      out(`  ${c.bold('Evaluation order')} ${c.dim(`(from ${rel(entry)}${info.kind === 'lazy' ? ', lazy chunk' : ''})`)}`);
      out(`    ${chainText(info.chain)}`);
      out(`    ${c.dim(`${rel(first.from)} runs while ${rel(ancestor)} has not finished loading.`)}`);
      if (app.length > 1) out(c.dim(`    also from: ${app.slice(1, 4).map(([e]) => rel(e)).join(', ')}${app.length > 4 ? ` +${app.length - 4}` : ''}`));
    }
    if (test.length > 0) {
      out(`  ${c.bold(app.length > 0 ? 'Also breaks in tests' : 'Breaks in tests')} ${c.dim(`(${test.length} spec${test.length === 1 ? '' : 's'}): ${test.slice(0, 3).map(([e]) => rel(e)).join(', ')}${test.length > 3 ? ', …' : ''}`)}`);
      if (app.length === 0) {
        const [, info] = test[0]!;
        out(`    ${chainText(info.chain)}`);
      }
    }
  }

  if (f.cycle) {
    out();
    out(`  ${c.bold(`Cycle (${f.cycle.nodes.length} files, group #${f.sccId})`)}`);
    const n = f.cycle.nodes.length;
    for (let i = 0; i < n; i++) {
      const node = f.cycle.nodes[i]!;
      const note = f.edgeNotes[i];
      const isFail = f.failures.some((fp) => fp.from === node);
      const arrow = i === 0 ? '  ' : '→ ';
      let line = `    ${c.dim(arrow)}${isFail ? c.red(rel(node)) : rel(node)}`;
      if (note) {
        const syms = note.symbols.slice(0, 4).join(', ') + (note.symbols.length > 4 ? ', …' : '');
        line += `  ${c.dim(`imports { ${syms} }`)}${note.viaBarrel ? c.magenta(' via barrel') : ''}  ${usageTag(note.usage)}`;
        if (note.sample && note.usage !== 'none') line += c.dim(` – ${note.sample.context} (L${note.sample.line})`);
      }
      out(line);
    }
    out(`    ${c.dim('→ ')}${c.dim(rel(f.cycle.nodes[0]!))}`);
  }

  if (f.diCycle) {
    out();
    out(`  ${c.bold('Injection chain')}`);
    for (const e of f.diCycle.edges) {
      const from = f.diCycle.nodes.find((n) => n.id === e.from);
      const to = f.diCycle.nodes.find((n) => n.id === e.to);
      const flags = Object.entries(e.dep.flags).filter(([, v]) => v).map(([k]) => `@${k}`).join(' ');
      out(`    ${from?.name ?? '?'} ${c.dim('needs')} ${to?.name ?? '?'}  ${c.dim(`${rel(e.fromPath)}:${e.dep.line} (${e.dep.via}${flags ? `, ${flags}` : ''})`)}`);
    }
  }

  if (f.suggestions.length > 0) {
    out();
    out(`  ${c.bold('How to fix')}`);
    for (const s of f.suggestions.slice(0, 4)) {
      out(`    ${s.verified ? c.green('✔') : c.yellow('•')} ${s.text}`);
      for (const d of s.details ?? []) out(`        ${c.dim(d)}`);
    }
  }
};
