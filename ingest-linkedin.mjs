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
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = getCareerOpsRoot();
const pipelinePath = join(CAREER_OPS, 'data', 'pipeline.md');

const LINK_RE = /https?:\/\/www\.linkedin\.com\/jobs\/view\/[^\s)"'<>]+|https?:\/\/www\.linkedin\.com\/jobs\/search[^\s)"'<>]*|https?:\/\/lnkd\.in\/[A-Za-z0-9_-]+/gi;

function extract(text) {
  const urls = (text.match(LINK_RE) || []).map((u) => u.replace(/[)>,;]+$/g, ''));
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

const lines = existsSync(pipelinePath) ? readFileSync(pipelinePath, 'utf8').split('\n') : ['# Pipeline — Pending URLs', '', 'Paste job URLs below as `- [ ] {url}` then run `/career-ops pipeline`.', '', '## Pending', ''];
let pendingIdx = lines.findIndex((l) => l === '## Pending');
if (pendingIdx === -1) { lines.push('## Pending', ''); pendingIdx = lines.length - 1; }
let insertAt = pendingIdx + 1;
for (const u of fresh) lines.splice(insertAt++, 0, `- [ ] ${u}`);
try {
  mkdirSync(dirname(pipelinePath), { recursive: true });
  writeFileSync(pipelinePath, lines.join('\n') + '\n');
} catch { console.error('write failed'); process.exit(4); }
console.log(`added ${fresh.length} LinkedIn job link(s) to pipeline (${urls.length - fresh.length} already present)`);
process.exit(0);