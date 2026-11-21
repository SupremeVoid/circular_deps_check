/**
 * `circdeps summary | list | explain | plan | simulate | diff` – the query layer on the command
 * line: small answers instead of the full report. Text by default, `--json` for machines.
 */
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { analyze } from './analyze.js';
import type { CircdepsOptions } from './config.js';
import type { FindingKind, Severity } from './types.js';
import { severityRank } from './analyze.js';
import { diffSnapshots, explainFinding, fixPlanFor, listFindingLines, listFindings, QueryError, simulate, snapshotFromReport, snapshotOf, summarize, toText, type ChangeRequest } from './query.js';
import type { JsonReport } from './report/json.js';

export const QUERY_COMMANDS = ['summary', 'list', 'explain', 'plan', 'simulate', 'diff'] as const;
export type QueryCommand = (typeof QUERY_COMMANDS)[number];

export const QUERY_HELP = `Focused questions (each prints a small answer; add --json for JSON):

  circdeps summary [root]                 counts, the problem groups and their fix in a few lines
  circdeps list [root]                    findings, one per line
      --severity <s> | --min-severity <s> | --kind <kind> | --file <text> | --group <n> | --limit <n>
  circdeps explain <id|key> [root]        one finding: failing line, load order, the cycle with its code, fixes
  circdeps plan <group|id> [root]         the fix plan of a group, with the replay after every step
  circdeps simulate [root]                what would crash if these imports changed – nothing is edited
      --remove <from,to>                  the import is gone (symbol or using code moved, dependency inverted)
      --direct <from,to>                  a barrel import replaced by imports of the declaring files
      --defer <from,to>                   the import stays, nothing of it is read at load time (forwardRef …)
  circdeps diff <baseline.json> [root]    what changed since a saved JSON report: resolved, new, changed
      --fail-on <severity>                exit 1 when a new finding of this severity or worse appeared (default: high)

  Files may be given relative to the root, absolute, or as a unique path ending (order-list.component.ts).
  The analysis options --entry, --test-entry, --no-tests, --include, --exclude, --tsconfig apply as usual.
`;

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];

export const runQueryCommand = async (cmd: QueryCommand, argv: string[]): Promise<number> => {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        tsconfig: { type: 'string' },
        include: { type: 'string', multiple: true },
        exclude: { type: 'string', multiple: true },
        entry: { type: 'string', multiple: true },
        'test-entry': { type: 'string', multiple: true },
        'no-tests': { type: 'boolean' },
        json: { type: 'boolean' },
        severity: { type: 'string' },
        'min-severity': { type: 'string' },
        kind: { type: 'string' },
        file: { type: 'string' },
        group: { type: 'string' },
        limit: { type: 'string' },
        remove: { type: 'string', multiple: true },
        direct: { type: 'string', multiple: true },
        defer: { type: 'string', multiple: true },
        'fail-on': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${QUERY_HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(QUERY_HELP);
    return 0;
  }
  // `explain`, `plan` and `diff` take their subject first, then the optional root.
  const needsSubject = cmd === 'explain' || cmd === 'plan' || cmd === 'diff';
  const subject = needsSubject ? positionals[0] : undefined;
  if (needsSubject && !subject) {
    process.stderr.write(`circdeps ${cmd}: missing ${cmd === 'diff' ? 'the baseline JSON report' : cmd === 'plan' ? 'a group number or finding id' : 'a finding id or key'}.\n\n${QUERY_HELP}`);
    return 2;
  }
  const root = path.resolve(positionals[needsSubject ? 1 : 0] ?? process.cwd());
  if (!fs.existsSync(root)) {
    process.stderr.write(`Root directory not found: ${root}\n`);
    return 2;
  }
  for (const key of ['severity', 'min-severity', 'fail-on'] as const) {
    const v = values[key];
    if (v !== undefined && !SEVERITIES.includes(v) && !(key === 'fail-on' && v === 'none')) {
      process.stderr.write(`Invalid --${key} value: ${v}\n`);
      return 2;
    }
  }
  const options: CircdepsOptions = {
    root,
    tsconfig: values.tsconfig,
    include: values.include,
    exclude: values.exclude,
    entries: values.entry,
    testEntries: values['test-entry'],
    noTestEntries: values['no-tests'],
    // only `plan` shows the replays of the fix plans
    fixPreview: cmd === 'plan' ? undefined : false,
  };
  const print = (view: unknown): void => {
    process.stdout.write(`${values.json ? JSON.stringify(view, null, 2) : toText(view)}\n`);
  };

  try {
    const result = await analyze(options);
    switch (cmd) {
      case 'summary':
        print(summarize(result));
        return 0;
      case 'list':
        print(
          (values.json ? listFindings : listFindingLines)(result, {
            severity: values.severity as Severity | undefined,
            minSeverity: values['min-severity'] as Severity | undefined,
            kind: values.kind as FindingKind | undefined,
            file: values.file,
            group: values.group !== undefined ? Number(values.group) : undefined,
            limit: values.limit !== undefined ? Number(values.limit) : undefined,
          }),
        );
        return 0;
      case 'explain':
        print(explainFinding(result, subject!));
        return 0;
      case 'plan':
        print(fixPlanFor(result, subject!));
        return 0;
      case 'simulate': {
        const changes: ChangeRequest[] = [];
        for (const action of ['remove', 'direct', 'defer'] as const) {
          for (const pair of values[action] ?? []) {
            const [from, to, ...rest] = pair.split(',').map((x) => x.trim());
            if (!from || !to || rest.length > 0) throw new QueryError(`--${action} expects "<importing file>,<imported file>", got "${pair}".`);
            changes.push({ from, to, action });
          }
        }
        if (changes.length === 0) throw new QueryError('Nothing to simulate: give at least one --remove, --direct or --defer "<importing file>,<imported file>".');
        print(simulate(result, changes));
        return 0;
      }
      case 'diff': {
        let report: JsonReport;
        try {
          report = JSON.parse(fs.readFileSync(path.resolve(subject!), 'utf8')) as JsonReport;
        } catch (err) {
          throw new QueryError(`Cannot read the baseline report "${subject}": ${(err as Error).message}`);
        }
        const diff = diffSnapshots(snapshotFromReport(report), snapshotOf(result));
        print(diff);
        const failOn = values['fail-on'] ?? 'high';
        if (failOn === 'none') return 0;
        return diff.introduced.some((f) => severityRank(f.severity) <= severityRank(failOn as Severity)) ? 1 : 0;
      }
    }
  } catch (err) {
    if (err instanceof QueryError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    process.stderr.write(`Analysis failed: ${(err as Error).stack ?? String(err)}\n`);
    return 2;
  }
};
