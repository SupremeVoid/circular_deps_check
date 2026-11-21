import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from './analyze.js';
import { renderTextReport } from './report/text.js';
import { renderHtmlReport } from './report/html.js';
import { toJsonReport } from './report/json.js';
import { c, setColor } from './util/ansi.js';
import type { Severity } from './types.js';
import { severityRank } from './analyze.js';

const readVersion = (): string => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const candidate of [path.join(here, '..', 'package.json'), path.join(here, '..', '..', 'package.json')]) {
      if (fs.existsSync(candidate)) return (JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version: string }).version;
    }
  } catch {
    /* ignore */
  }
  return '0.0.0';
};

const HELP = `circdeps – circular dependency checker for TypeScript / Angular projects

Usage: circdeps [root] [options]

Finds import cycles, replays the ES-module evaluation order from your entry points and reports
the cycles that really break (TDZ / undefined at load time) and Angular DI cycles (NG0200) –
with fix plans that are replayed to show what is left afterwards. Cycles that only depend on
the import order are listed separately as low.

Options:
  --tsconfig <path>        tsconfig used for path aliases (auto-detected)
  --include <glob>         files to analyze, repeatable (default: **/*.{ts,tsx,mts,cts})
  --exclude <glob>         files to skip, repeatable (node_modules, dist, .angular, *.d.ts are always skipped)
  --entry <path|glob>      application entry point(s), repeatable (default: src/main.ts)
  --test-entry <glob>      test entry glob(s), repeatable (default: **/*.spec.ts)
  --no-tests               do not evaluate test entries
  --out <dir>              report directory (default: ./reports); writes circular-deps.{txt,html,json}
  --display-root <text>    show this instead of the absolute project path (reports that leave the
                           machine: CI artifacts, published samples); switches editor links off
  --format <list>          comma separated: text,html,json (default: text,html,json)
  --fail-on <severity>     exit 1 when a finding of this severity or worse exists
                           (critical|high|medium|low|info|none; default: high)
  --max-cycles <n>         cycles enumerated per cyclic group (default: 200)
  --max-findings <n>       findings printed per severity in the text report (default: 40)
  --verbose                print low/info findings in the terminal as well
  --quiet                  print only the summary
  --json                   print the JSON report to stdout instead of text
  --no-color               disable ANSI colors
  --no-angular             skip Angular DI analysis
  --no-fix-preview         do not replay the entry points with each fix plan applied
  --emit-decorator-metadata  force emitDecoratorMetadata semantics (constructor param types are values)
  -h, --help               show this help
  -v, --version            show version

Config file: circdeps.config.json in the project root (same keys as the JS API options).
`;

export const runCli = async (argv: string[]): Promise<number> => {
  let parsed: ReturnType<typeof parseArgs<typeof spec>>;
  const spec = {
    options: {
      tsconfig: { type: 'string' as const },
      include: { type: 'string' as const, multiple: true },
      exclude: { type: 'string' as const, multiple: true },
      entry: { type: 'string' as const, multiple: true },
      'test-entry': { type: 'string' as const, multiple: true },
      'no-tests': { type: 'boolean' as const },
      out: { type: 'string' as const },
      'display-root': { type: 'string' as const },
      format: { type: 'string' as const },
      'fail-on': { type: 'string' as const },
      'max-cycles': { type: 'string' as const },
      'max-findings': { type: 'string' as const },
      verbose: { type: 'boolean' as const },
      quiet: { type: 'boolean' as const },
      json: { type: 'boolean' as const },
      'no-color': { type: 'boolean' as const },
      'no-angular': { type: 'boolean' as const },
      'no-fix-preview': { type: 'boolean' as const },
      'emit-decorator-metadata': { type: 'boolean' as const },
      help: { type: 'boolean' as const, short: 'h' },
      version: { type: 'boolean' as const, short: 'v' },
    },
    allowPositionals: true,
    args: argv,
  };
  try {
    parsed = parseArgs(spec);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const version = readVersion();
  if (values.version) {
    process.stdout.write(`${version}\n`);
    return 0;
  }
  if (values['no-color'] || values.json) setColor(false);

  const root = path.resolve(positionals[0] ?? process.cwd());
  if (!fs.existsSync(root)) {
    process.stderr.write(`Root directory not found: ${root}\n`);
    return 2;
  }
  const failOn = (values['fail-on'] ?? 'high') as Severity | 'none';
  if (!['critical', 'high', 'medium', 'low', 'info', 'none'].includes(failOn)) {
    process.stderr.write(`Invalid --fail-on value: ${failOn}\n`);
    return 2;
  }
  const formats = new Set((values.format ?? 'text,html,json').split(',').map((s) => s.trim()).filter(Boolean));
  const outDir = path.resolve(values.out ?? path.join(process.cwd(), 'reports'));

  const log = (msg: string): void => {
    if (!values.json && !values.quiet) process.stderr.write(`${c.dim(msg)}\n`);
  };

  const arr = (v: string | string[] | undefined): string[] | undefined => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);
  let result;
  try {
    result = await analyze(
      {
        root,
        tsconfig: values.tsconfig,
        include: arr(values.include),
        exclude: arr(values.exclude),
        entries: arr(values.entry),
        testEntries: arr(values['test-entry']),
        noTestEntries: values['no-tests'],
        maxCyclesPerScc: values['max-cycles'] ? Number(values['max-cycles']) : undefined,
        maxFindingsPerSeverity: values['max-findings'] ? Number(values['max-findings']) : undefined,
        angular: values['no-angular'] ? false : undefined,
        fixPreview: values['no-fix-preview'] ? false : undefined,
        emitDecoratorMetadata: values['emit-decorator-metadata'] ? true : undefined,
      },
      (phase) => log(`… ${phase}`),
    );
  } catch (err) {
    process.stderr.write(`${c.red('Analysis failed:')} ${(err as Error).stack ?? String(err)}\n`);
    return 2;
  }

  const reportOpts = { displayRoot: values['display-root'] };
  const written: string[] = [];
  const htmlPath = path.join(outDir, 'circular-deps.html');
  if (formats.has('html') || formats.has('json') || formats.has('text')) fs.mkdirSync(outDir, { recursive: true });
  if (formats.has('html')) {
    fs.writeFileSync(htmlPath, renderHtmlReport(result, version, reportOpts), 'utf8');
    written.push(htmlPath);
  }
  if (formats.has('json')) {
    const p = path.join(outDir, 'circular-deps.json');
    fs.writeFileSync(p, JSON.stringify(toJsonReport(result, version, reportOpts), null, 2), 'utf8');
    written.push(p);
  }
  const textOpts = { displayRoot: values['display-root'], verbose: values.verbose, quiet: values.quiet, maxPerSeverity: values['max-findings'] ? Number(values['max-findings']) : undefined, htmlPath: formats.has('html') ? htmlPath : undefined };
  if (formats.has('text')) {
    const p = path.join(outDir, 'circular-deps.txt');
    const prev = process.stdout.isTTY;
    setColor(false);
    // The file version is always complete, regardless of --quiet/--verbose.
    fs.writeFileSync(p, renderTextReport(result, { ...textOpts, verbose: true, quiet: false }), 'utf8');
    setColor(Boolean(prev) && !values['no-color'] && !values.json);
    written.push(p);
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(toJsonReport(result, version, reportOpts), null, 2)}\n`);
  } else {
    process.stdout.write(`${renderTextReport(result, textOpts)}\n`);
    if (written.length > 0) process.stdout.write(`${c.dim(`Reports written: ${written.map((w) => path.relative(process.cwd(), w)).join(', ')}`)}\n`);
  }

  if (failOn === 'none') return 0;
  const worst = result.findings.reduce<number>((acc, f) => Math.min(acc, severityRank(f.severity)), 99);
  return worst <= severityRank(failOn) ? 1 : 0;
};

const isDirectRun = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  const norm = (p: string): string => path.resolve(p).toLowerCase();
  return norm(entry) === norm(self) || /circdeps(\.js)?$/i.test(entry);
};

if (isDirectRun()) {
  // `circdeps | head` closes stdout early; that is not an error worth a stack trace.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(process.exitCode ?? 0);
    throw err;
  });
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
      process.exitCode = 2;
    },
  );
}
