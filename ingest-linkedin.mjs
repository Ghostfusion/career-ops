// @ts-check
/**
 * ingest-linkedin.mjs — turn LinkedIn job-alert emails into pending pipeline
 * rows, so the inbox stays warm without manual pasting.
 *
 * The Gmail plugin is registered but requires API tokens; this script works
 * with zero tokens: paste the alert email body (or a file path to it) and it
 * extracts job URLs, then appends them as `- [ ] {url}` pending rows in
 * data/pipeline.md. Dedup is by URL against existing pending/processed
 * pipeline lines, so re-importing an alert is harmless.
 *
 * Usage:
 *   node ingest-linkedin.mjs --text "<pasted alert body>"
 *   node ingest-linkedin.mjs --file alert.txt
 *   node ingest-linkedin.mjs --json        → extracted links, no write
 *   node ingest-linkedin.mjs --self-test
 *
 * It never touches applications.md — only appends to the pipeline inbox (the
 * same file the `pipeline` mode drains).
 */
import { dirname, join } from 'path';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';
import { writeFileAtomic } from './tracker-utils.mjs';

const CAREER_OPS = getCareerOpsRoot();
const pipelinePath = join(CAREER_OPS, 'data', 'pipeline.md');

// Canonical section markers, the same vocabulary scan.mjs uses (it keeps
// `## Pendientes` for files written before the rename and scan-ats-full.mjs
// auto-creates it). A section is matched trimmed, so a CRLF file matches too.
const PENDING_MARKERS = ['## Pending', '## Pendientes'];

const LINK_RE = /https?:\/\/www\.linkedin\.com\/jobs\/view\/[^\s)"'<>]+|https?:\/\/www\.linkedin\.com\/jobs\/search[^\s)"'<>]*|https?:\/\/lnkd\.in\/[A-Za-z0-9_-]+/gi;

function extract(text) {
  // A link that ends a sentence keeps its trailing `.`/`!` (and the `)` of a
  // "(see …)" is already excluded by the pattern) — writing that punctuation
  // into the pipeline makes a broken URL. `?` and `/` are deliberately NOT
  // stripped: query strings and trailing slashes are part of the URL.
  const urls = (text.match(LINK_RE) || []).map((u) => u.replace(/[)>,;.!]+$/g, ''));
  const seen = new Set(); const out = [];
  for (const u of urls) { if (!seen.has(u)) { seen.add(u); out.push(u); } }
  return out;
}

function existingPipelineUrls() {
  if (!existsSync(pipelinePath)) return new Set();
  const seen = new Set();
  for (const line of readFileSync(pipelinePath, 'utf8').split('\n')) {
    const m = line.match(/\[[ x]\]\s+(\S+)/);
    if (m && /^https?:/i.test(m[1])) seen.add(m[1]);
  }
  return seen;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  const sample = 'a https://www.linkedin.com/jobs/view/123 b https://www.linkedin.com/jobs/view/123 c';
  const urls = extract(sample);
  const checks = [
    ['extract dedupes exact repeats', urls.length === 1],
    ['extract keeps distinct', extract('x https://www.linkedin.com/jobs/view/1 y https://www.linkedin.com/jobs/view/2 z').length === 2],
    ['matches short link', extract('x https://lnkd.in/abcd y').length === 1],
    ['no link → empty', extract('no links here').length === 0],
    // A URL that ends a sentence: the period is punctuation, not the URL.
    ['strips a trailing sentence period', extract('Apply at https://www.linkedin.com/jobs/view/4012345678.').join() === 'https://www.linkedin.com/jobs/view/4012345678'],
    ['strips trailing ! and ,', extract('see https://www.linkedin.com/jobs/view/7!, x').join() === 'https://www.linkedin.com/jobs/view/7'],
    ['keeps a query string and trailing slash', extract('x https://www.linkedin.com/jobs/view/1/?refId=a b').join() === 'https://www.linkedin.com/jobs/view/1/?refId=a'],
  ];
  let n = 0;
  for (const [name, ok] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name}`); if (ok) n++; }
  console.log(`\ningest-linkedin self-test: ${n}/${checks.length} passed`);
  process.exit(n === checks.length ? 0 : 1);
}

const fi = args.indexOf('--file');
const ai = args.indexOf('--text');
let text = '';
if (fi !== -1 && args[fi + 1]) { try { text = readFileSync(args[fi + 1], 'utf8'); } catch { console.error('cannot read file:', args[fi + 1]); process.exit(2); } }
else if (ai !== -1 && args[ai + 1]) text = args[ai + 1];
else if (!args.includes('--json')) { console.error('Usage: --text "<body>" | --file alert.txt | --json'); process.exit(1); }

const urls = extract(text || '');
if (args.includes('--json')) { console.log(JSON.stringify(urls, null, 2)); process.exit(0); }
if (urls.length === 0) { console.log('no LinkedIn job links found in the alert'); process.exit(0); }

const existing = existingPipelineUrls();
const fresh = urls.filter((u) => !existing.has(u));
if (fresh.length === 0) { console.log('all alert links already present in pipeline'); process.exit(0); }

let added = 0;
try {
  // Every other writer of data/pipeline.md (scan.mjs's appendToPipeline,
  // scan-ats-full.mjs, plugins.mjs, rank-pipeline.mjs) takes this same lock. A
  // bare read→splice→write here raced them: whichever write landed second
  // overwrote the first's read, so a concurrent scan's rows vanished silently.
  // The dedupe read is re-done inside the lock for the same reason — the file
  // can gain rows between the check above and the write below.
  await withPipelineLock(pipelinePath, async () => {
    const present = existingPipelineUrls();
    const missing = urls.filter((u) => !present.has(u));
    if (missing.length === 0) return;

    const lines = existsSync(pipelinePath)
      ? readFileSync(pipelinePath, 'utf8').split('\n')
      : ['# Pipeline — Pending URLs', '', 'Paste job URLs below as `- [ ] {url}` then run `/career-ops pipeline`.', '', '## Pending', ''];
    // Match the section the way scan.mjs does — either marker, trimmed — rather
    // than by exact-line equality with '## Pending': a file that says
    // `## Pendientes` (scan-ats-full.mjs creates that spelling) or carries CRLF
    // line endings used to get a duplicate `## Pending` section appended.
    let pendingIdx = lines.findIndex((l) => PENDING_MARKERS.includes(l.trim()));
    if (pendingIdx === -1) { lines.push('## Pending', ''); pendingIdx = lines.length - 1; }
    let insertAt = pendingIdx + 1;
    for (const u of missing) lines.splice(insertAt++, 0, `- [ ] ${u}`);

    mkdirSync(dirname(pipelinePath), { recursive: true });
    writeFileAtomic(pipelinePath, lines.join('\n') + '\n');
    added = missing.length;
  });
} catch { console.error('write failed'); process.exit(4); }
if (added === 0) { console.log('all alert links already present in pipeline'); process.exit(0); }
console.log(`added ${added} LinkedIn job link(s) to pipeline (${urls.length - added} already present)`);
process.exit(0);