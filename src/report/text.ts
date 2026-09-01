import type { AnalysisResult, Finding, Severity } from '../types.js';
import { c } from '../util/ansi.js';
import { relativeTo } from '../util/paths.js';
import { countBySeverity } from '../analyze.js';

export interface TextReportOptions {
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

  out(c.bold(`circular-deps-check`) + c.dim(`  ${result.root}`));
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
  row('critical', 'load-time crashes reachable from the app entry');
  row('high', 'DI cycles (NG0200) and crashes reachable only from tests');
  row('medium', 'order-dependent cycles (eager use, currently lucky)');
  row('low', 'cycles with deferred usage only (fragile)');
  row('info', 'type-only cycles (erased – no action)');
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

  const plans = result.fixPlans.filter((p) => p.cuts.length > 0);
  if (plans.length > 0) {
    out(c.bold('━━ Fix plan per cyclic group ' + '━'.repeat(40)));
    out(c.dim('  Removing these edges (in order) makes the whole group acyclic. Cheapest edges first (barrels, unused bindings).'));
    out();
    for (const plan of plans.slice(0, 15)) {
      const scc = result.sccs.find((s) => s.id === plan.sccId)!;
      out(`  Group #${plan.sccId} – ${scc.nodes.length} files, ${scc.cycles.length}${scc.truncated ? '+' : ''} cycles${plan.verified ? c.green('  ✔ plan verified acyclic') : c.yellow('  (plan incomplete)')}`);
      for (const cut of plan.cuts.slice(0, 12)) {
        out(`    ✂ ${rel(cut.from)} ${c.dim('→')} ${rel(cut.to)}  ${c.dim(`{ ${cut.symbols.slice(0, 4).join(', ')}${cut.symbols.length > 4 ? ', …' : ''} }`)}  ${usageTag(cut.usage)}  ${c.dim(cut.reason)}`);
      }
      if (plan.cuts.length > 12) out(c.dim(`    … ${plan.cuts.length - 12} more cuts`));
      out();
    }
    if (plans.length > 15) out(c.dim(`  … ${plans.length - 15} more groups in the HTML report`));
    out();
  }

  if (opts.htmlPath) out(c.dim(`Full interactive report: ${opts.htmlPath}`));
  return lines.join('\n');
};

const renderFinding = (f: Finding, result: AnalysisResult, out: (s?: string) => void): void => {
  const rel = (p: string): string => relativeTo(result.root, p);
  out(`${SEV_LABEL[f.severity](`[${f.id}] ${f.severity.toUpperCase()}`)}  ${c.bold(f.title)}`);
  out(`  ${f.summary}`);

  if (f.failures.length > 0) {
    const first = f.failures[0]!;
    out();
    out(`  ${c.bold('Point of failure')}`);
    for (const fp of f.failures.slice(0, 4)) {
      out(`    ${c.underline(`${rel(fp.from)}:${fp.usage.line}:${fp.usage.column}`)}  ${c.dim(fp.usage.snippet)}`);
      out(`      ↳ \`${fp.symbol}\` (${fp.originKind}) is declared in ${rel(fp.originPath ?? fp.to)}, which is ${fp.state === 'tdz' ? 'still initialising → TDZ ReferenceError' : 'not initialised yet → undefined'}; context: ${fp.usage.context}`);
    }
    if (f.failures.length > 4) out(c.dim(`    … ${f.failures.length - 4} more usages on this edge`));
    const entries = new Map<string, { kind: string; chain: string[] }>();
    for (const fp of f.failures) for (const e of fp.entries) if (!entries.has(e.entry)) entries.set(e.entry, e);
    const app = [...entries.entries()].filter(([, e]) => e.kind !== 'test');
    const test = [...entries.entries()].filter(([, e]) => e.kind === 'test');
    const ancestor = first.to;
    const chainText = (chain: string[]): string =>
      chain
        .map((p, i) => (p === ancestor ? c.yellow(`${rel(p)} ⟳`) : i === chain.length - 1 ? c.red(`${rel(p)} ✖`) : rel(p)))
        .join(c.dim(' → '));
    if (app.length > 0) {
      const [entry, info] = app[0]!;
      out();
      out(`  ${c.bold('Evaluation order')} ${c.dim(`(from ${rel(entry)}${info.kind === 'lazy' ? ', lazy chunk' : ''})`)}`);
      out(`    ${chainText(info.chain)}`);
      out(`    ${c.dim(`${rel(ancestor)} starts loading, reaches ${rel(first.from)} through its imports, which reads back from it before its body has run.`)}`);
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
