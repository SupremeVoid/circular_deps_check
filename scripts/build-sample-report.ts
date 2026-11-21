/**
 * Builds the published sample report (GitHub Pages serves the `docs/` folder):
 *   docs/sample-report/index.html – the HTML report of fixtures/07-shop-app
 *   docs/index.html               – forwards to it
 *
 * usage: bun run sample:report
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, renderHtmlReport } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const version = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version;

const result = await analyze({ root: path.join(root, 'fixtures', '07-shop-app'), entries: ['src/main.ts'] });
// The page is public: show a project name instead of the path on the machine that built it.
const html = renderHtmlReport(result, version, { displayRoot: 'shop-app (sample project)' });

const out = path.join(root, 'docs', 'sample-report');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), html, 'utf8');
fs.writeFileSync(path.join(root, 'docs', '.nojekyll'), '', 'utf8');
fs.writeFileSync(
  path.join(root, 'docs', 'index.html'),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>circular-deps-check – sample report</title>
<meta http-equiv="refresh" content="0; url=sample-report/">
<link rel="canonical" href="sample-report/">
</head>
<body>
<p>The sample report is at <a href="sample-report/">sample-report/</a>.</p>
</body>
</html>
`,
  'utf8',
);

const counts: Record<string, number> = {};
for (const f of result.findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
console.log(`docs/sample-report/index.html written (${result.stats.files} files analysed, ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')})`);
