/**
 * `circdeps mcp` – a Model Context Protocol server (stdio) on top of the query layer, so that an
 * agent can check a project, look at one finding, try a fix on paper and verify its edits.
 *
 * The server is read-only: it analyses files and never changes one. It keeps the last analysis of
 * each project in memory, which is what `recheck` compares against.
 */
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { analyze } from './analyze.js';
import type { CircdepsOptions } from './config.js';
import type { AnalysisResult } from './types.js';
import { diffResults, explainFinding, fixPlanFor, listFindingLines, QueryError, simulate, summarize, toText } from './query.js';
import { normalizePath } from './util/paths.js';

const INSTRUCTIONS = `Finds the import cycles of a TypeScript / Angular project that actually break at load time, and helps to fix them.

Severity says how real a problem is today: critical/high = proven crash (fix), medium = possible crash on a real load path (check the stated reason), low = order-dependent, works in every current load order (leave unless asked), info = cannot crash.

Workflow:
1. analyze – counts, the problem groups and their fix in a few lines.
2. get_finding – one finding with the failing line, the load order that leads to it and the code behind each import of the cycle. get_fix_plan – the planned import changes of a group and what a replay shows after each step.
3. simulate_changes – before editing: what would crash if these imports changed. Changing an import changes the load order, so a read that is fine today can become the next crash ("newlyFailing").
4. Edit the files yourself, then recheck – what is resolved, what is new.

Finding ids (C1, C2 …) are positions in the current run and change after edits; keys are stable. The server never modifies files.`;

interface Session {
  result: AnalysisResult;
  /** The first analysis of this project in this session – `recheck` can compare against it. */
  baseline: AnalysisResult;
  options: CircdepsOptions;
}

export const createServer = (defaults: CircdepsOptions & { root: string }, version: string): McpServer => {
  const server = new McpServer({ name: 'circdeps', version }, { instructions: INSTRUCTIONS });
  const sessions = new Map<string, Session>();

  const rootOf = (root: string | undefined): string => {
    const abs = normalizePath(root ? path.resolve(defaults.root, root) : defaults.root);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new QueryError(`Project root not found: ${abs}`);
    return abs;
  };
  const run = async (root: string, overrides: Partial<CircdepsOptions> = {}): Promise<AnalysisResult> => {
    const known = sessions.get(root);
    const options: CircdepsOptions = { ...defaults, ...(known?.options ?? {}), ...overrides, root };
    const result = await analyze(options);
    sessions.set(root, { result, baseline: known?.baseline ?? result, options });
    return result;
  };
  /** The current analysis of a project, running one first if there is none yet. */
  const current = async (root: string | undefined): Promise<AnalysisResult> => {
    const abs = rootOf(root);
    return sessions.get(abs)?.result ?? run(abs);
  };
  const answer = async (fn: () => Promise<unknown>): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> => {
    try {
      return { content: [{ type: 'text', text: toText(await fn()) }] };
    } catch (err) {
      const text = err instanceof QueryError ? err.message : `circdeps failed: ${(err as Error).message}`;
      return { content: [{ type: 'text', text }], isError: true };
    }
  };

  const root = z.string().optional().describe('Project root (absolute, or relative to the server\'s default root). Omit to use the default root the server was started with.');
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    'analyze',
    {
      title: 'Analyze import cycles',
      description:
        'Analyse the project (fresh run) and return a summary: counts per severity, a verdict, and each problem group with its findings and the imports to change. Start here. Takes a few seconds on a large project.',
      inputSchema: {
        root,
        entries: z.array(z.string()).optional().describe('App entry point(s), relative to the root. Default: src/main.ts.'),
        testEntries: z.array(z.string()).optional().describe('Globs of spec files, each loaded on its own. Default: **/*.spec.ts.'),
        noTests: z.boolean().optional().describe('Ignore spec files.'),
      },
      annotations: readOnly,
    },
    ({ root: r, entries, testEntries, noTests }) =>
      answer(async () => {
        const overrides: Partial<CircdepsOptions> = {};
        if (entries) overrides.entries = entries;
        if (testEntries) overrides.testEntries = testEntries;
        if (noTests !== undefined) overrides.noTestEntries = noTests;
        return summarize(await run(rootOf(r), overrides));
      }),
  );

  server.registerTool(
    'list_findings',
    {
      title: 'List findings',
      description: 'List findings of the current analysis, one line each: id, severity, kind, group, what, file:line and when it fails. Filter to keep the answer small.',
      inputSchema: {
        root,
        severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional().describe('Exactly this severity.'),
        minSeverity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional().describe('This severity or worse, e.g. "medium" for everything that is or may be broken.'),
        kind: z.enum(['runtime-break', 'test-break', 'possible-break', 'di-cycle', 'latent-cycle', 'deferred-cycle', 'type-only-cycle']).optional(),
        file: z.string().optional().describe('Only findings that involve a file whose path contains this text.'),
        group: z.number().int().optional().describe('Only findings of this cyclic group.'),
        limit: z.number().int().positive().optional().describe('Maximum number of rows (default 50).'),
      },
      annotations: readOnly,
    },
    ({ root: r, ...filter }) => answer(async () => listFindingLines(await current(r), filter)),
  );

  server.registerTool(
    'get_finding',
    {
      title: 'Explain one finding',
      description:
        'Everything about one finding: the failing read(s) with file:line and source line, the error, the load order from the entry point to the failing file, the cycle with the import statement and usage lines of every import, and verified fix options. For an order-dependent finding: which file would have to be imported first, and why that does not happen today.',
      inputSchema: {
        root,
        finding: z.string().describe('Finding id of the current run (e.g. "C1") or its stable key.'),
        maxReads: z.number().int().positive().optional().describe('Maximum number of failing reads to list (default 10).'),
      },
      annotations: readOnly,
    },
    ({ root: r, finding, maxReads }) => answer(async () => explainFinding(await current(r), finding, { maxReads })),
  );

  server.registerTool(
    'get_fix_plan',
    {
      title: 'Fix plan of a cyclic group',
      description:
        'The fewest imports to change so that a cyclic group is no longer cyclic, in order, with instructions – and what replaying the entry points shows after each step: which findings are resolved, which reads still fail, and which read would become the next crash if you stopped there.',
      inputSchema: {
        root,
        group: z.union([z.number().int(), z.string()]).describe('Group number (from analyze) or the id/key of one of its findings.'),
      },
      annotations: readOnly,
    },
    ({ root: r, group }) => answer(async () => fixPlanFor(await current(r), group)),
  );

  server.registerTool(
    'simulate_changes',
    {
      title: 'Simulate import changes',
      description:
        'Try a fix on paper before editing: replay the entry points as if the given imports had changed. Returns the findings that would be resolved, the reads in the touched groups that would still fail, and "newlyFailing" – reads that are fine today and would crash because the load order changed. No file is modified.',
      inputSchema: {
        root,
        changes: z
          .array(
            z.object({
              from: z.string().describe('The importing file (relative to the root, absolute, or a unique path ending).'),
              to: z.string().describe('The imported file.'),
              action: z
                .enum(['remove', 'direct', 'defer'])
                .describe('remove: the import is gone (symbol moved to a file outside the cycle, using code moved, dependency inverted). direct: a barrel import replaced by imports of the files that declare the names. defer: the import stays, but nothing of it is read while the file loads (forwardRef, access moved into a function).'),
            }),
          )
          .min(1),
      },
      annotations: readOnly,
    },
    ({ root: r, changes }) => answer(async () => simulate(await current(r), changes)),
  );

  server.registerTool(
    'recheck',
    {
      title: 'Re-analyse and compare',
      description:
        'Run the analysis again after you edited files and compare with the previous run (or with the first run of this session): findings resolved, new findings, findings whose severity or failing reads changed. Use it after every fix to confirm nothing new surfaced.',
      inputSchema: {
        root,
        since: z.enum(['previous', 'baseline']).optional().describe('Compare with the previous analysis (default) or with the first analysis of this session.'),
      },
      annotations: readOnly,
    },
    ({ root: r, since }) =>
      answer(async () => {
        const abs = rootOf(r);
        const known = sessions.get(abs);
        if (!known) return { note: 'No earlier analysis of this project in this session – this run is the baseline.', ...summarize(await run(abs)) };
        const before = since === 'baseline' ? known.baseline : known.result;
        const after = await run(abs);
        return { comparedWith: since === 'baseline' ? 'first analysis of this session' : 'previous analysis', ...diffResults(before, after) };
      }),
  );

  return server;
};

export const MCP_HELP = `circdeps mcp – Model Context Protocol server (stdio) for AI agents

  circdeps mcp [--root <dir>] [--entry <path>] [--test-entry <glob>] [--no-tests] [--tsconfig <path>]

Tools: analyze, list_findings, get_finding, get_fix_plan, simulate_changes, recheck.
The server only reads files. --root is the default project (default: the working directory);
every tool also accepts a \`root\` argument.
`;

export const runMcpServer = async (argv: string[], version: string): Promise<number> => {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        root: { type: 'string' },
        tsconfig: { type: 'string' },
        include: { type: 'string', multiple: true },
        exclude: { type: 'string', multiple: true },
        entry: { type: 'string', multiple: true },
        'test-entry': { type: 'string', multiple: true },
        'no-tests': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${MCP_HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(MCP_HELP);
    return 0;
  }
  const root = normalizePath(path.resolve(values.root ?? positionals[0] ?? process.cwd()));
  const server = createServer(
    { root, tsconfig: values.tsconfig, include: values.include, exclude: values.exclude, entries: values.entry, testEntries: values['test-entry'], noTestEntries: values['no-tests'] },
    version,
  );
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; anything for a human goes to stderr
  process.stderr.write(`circdeps MCP server ${version} ready (default root: ${root})\n`);
  // stay alive until the client closes the connection
  await new Promise<void>((resolve) => {
    process.stdin.on('close', resolve);
    process.stdin.on('end', resolve);
  });
  return 0;
};
