// @ts-check
/**
 * close-loop.mjs — turn a recorded rejection into a concrete profile edit, so
 * rejection becomes a CV-improvement cycle instead of a dead end.
 *
 * Reads an `outcome`/`Rejected` tracker row's report, extracts the dominant
 * soft gap / reason, and proposes a targeted edit to `modes/_profile.md` or
 * `cv.md` (or a launchpad prep task). It NEVER writes those files itself — it
 * prints a proposal the user (or mode) reviews and acts on. Writing to
 * user-layer files requires explicit confirmation in the mode.
 *
 * Usage:
 *   node close-loop.mjs <row#>             → proposal for that rejected row
 *   node close-loop.mjs <row#> --json      → proposal as JSON
 *   node close-loop.mjs --self-test
 *
 * Exit codes: 0 ok · 1 usage · 2 row not found/not rejected.
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolveTrackerPath } from './tracker-utils.mjs';
import { resolveColumns, isSeparatorRow, isHeaderRow, parseTrackerRow, extractTrackerReportNumbers } from './tracker-parse.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = getCareerOpsRoot();

// ── report + tracker reading ─────────────────────────────────────────────────
function resolveReportPath(num) {
  const base = join(CAREER_OPS, 'reports');
  if (!existsSync(base)) return null;
  try {
    const hit = readdirSync(base).find((f) => new RegExp(`^0*${num}-[^/]+\\.md$`, 'i').test(f));
    return hit ? join(base, hit) : null;
  } catch { return null; }
}
function readReportYaml(p) {
  try {
    const t = readFileSync(p, 'utf8');
    const fence = t.match(/```yaml[^\n]*\n([\s\S]*?)\n```/);
    if (!fence) return {};
    const out = {}; let listKey = null;
    for (const raw of fence[1].split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (/^\s{2,}\w+:/.test(line) || !line.trim()) { listKey = null; continue; }
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (kv) { out[kv[1]] = strip(kv[2]); listKey = kv[1]; continue; }
      const item = line.match(/^\s*-\s+(.*)$/);
      if (item) { out[listKey] = out[listKey] || []; out[listKey].push(strip(item[1])); continue; }
      listKey = null;
    }
    return out;
  } catch { return {}; }
}
function strip(s) { return String(s).trim().replace(/^(["'])(.*)\1$/, '$2'); }

function trackerRow(num) {
  const appsFile = resolveTrackerPath(CAREER_OPS);
  if (!existsSync(appsFile)) return null;
  const lines = readFileSync(appsFile, 'utf8').split('\n');
  const colmap = resolveColumns(lines);
  for (const line of lines) {
    if (isSeparatorRow(line) || isHeaderRow(line) || !line.trim()) continue;
    const row = parseTrackerRow(line, colmap);
    if (row && row.num === num) return row;
  }
  return null;
}

function proposeFor(row, yaml) {
  const notes = row.notes || '';
  const gap = (Array.isArray(yaml.soft_gaps) ? yaml.soft_gaps : [])
    .concat(Array.isArray(yaml.hard_stops) ? yaml.hard_stops : [])
    .concat((yaml.discard_reasons || []))
    .find((g) => !/relocat|in-person|sponsorship|fluency/i.test(g)) || notes;
  const target = chooseTarget(gap);
  return {
    row: row.num,
    company: row.company,
    role: row.role,
    gap: gap || 'no explicit gap in report',
    target,
    action: target === 'launchpad-prep' ? 'clear the prep task, then re-run launchpad' : `Edit ${target} to address: “${gap}”`,
  };
}

// Decide where the fix lives: cv.md (skill/fact), _profile.md (framing), or a launchpad prep task.
function chooseTarget(gap) {
  if (/portfolio|demo|github|artifact|publish|eval harness|open[- ]?source/i.test(gap)) return 'launchpad-prep';
  if (/framing|position|narrative|archetype|emphas/i.test(gap)) return 'modes/_profile.md';
  return 'cv.md';
}

// Pre-defined prep task suggestions for common fixable gaps.
function prepTaskFor(gap) {
  if (/portfolio|demo|github|publish|eval harness/.test(gap)) return 'publish the artifact the report asked for, then mark it published in proof-point-bank';
  if (/comp|salary|base/.test(gap)) return 'verify the comp band on the first recruiter call, then flag the row in launchpad';
  return `prepare evidence for: “${gap}” (add to cv.md once it exists)`;
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  const fake = { num: 8, company: 'X', role: 'Y', notes: 'wanted a demo' };
  const yaml = { soft_gaps: ['no runnable eval demo', 'MCP authorship not shown'] };
  const p = proposeFor(fake, yaml);
  const checks = [
    ['picks non-trivial gap', p.gap === 'no runnable eval demo'],
    ['routes to launchpad-prep', p.target === 'launchpad-prep'],
    ['routes framing to _profile', proposeFor({ ...fake, notes: 'framing mismatch' }, { soft_gaps: ['narrative positioning weak'] }).target === 'modes/_profile.md'],
    ['defaults to cv.md', proposeFor({ ...fake, notes: 'rejected, no feedback given' }, { soft_gaps: [] }).target === 'cv.md'],
  ];
  let n = 0;
  for (const [name, ok] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name}`); if (ok) n++; }
  console.log(`\nclose-loop self-test: ${n}/${checks.length} passed`);
  process.exit(n === checks.length ? 0 : 1);
}

const selRaw = args[0] || args[args.indexOf('--row') + 1];
const num = (args.indexOf('--row') !== -1) ? parseInt(args[args.indexOf('--row') + 1], 10) : parseInt(selRaw, 10);
if (!num || isNaN(num)) { console.error('Usage: node close-loop.mjs <row#> [--json]'); process.exit(1); }
const row = trackerRow(num);
if (!row) { console.error(`no tracker row #${num}`); process.exit(2); }
  const status = String(row.status).trim();
  if (status !== 'Rejected') console.log(`(row is ${status}, not Rejected — treating as preventive gap review)`);
const reportNum = (extractTrackerReportNumbers(row.report, row.notes)[0]) ?? num;
const rp = resolveReportPath(reportNum);
const yaml = rp ? readReportYaml(rp) : {};
const proposal = proposeFor(row, yaml);
if (args.includes('--json')) { console.log(JSON.stringify(proposal, null, 2)); process.exit(0); }
console.log(`close-loop proposal for #${row.num} (${row.company} · ${row.role})`);
console.log(`  status: ${status}`);
console.log(`  gap:    ${proposal.gap}`);
console.log(`  target: ${proposal.target}`);
console.log(`  action: ${proposal.action}`);
if (proposal.target === 'launchpad-prep') console.log(`  prep:   ${prepTaskFor(proposal.gap)}`);
process.exit(0);