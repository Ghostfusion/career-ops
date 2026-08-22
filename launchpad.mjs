// @ts-check
/**
 * launchpad.mjs — turn evaluated-but-unactioned tracker rows into a
 * prioritized, action-ready queue.
 *
 * Serves the conversion that matters in this checkout: 42 rows Evaluated, zero
 * moved forward. The script (zero-LLM, deterministic, testable) reads the
 * tracker plus each open row's evaluation report, assigns a readiness tier,
 * names the blocking gap, and hands `modes/launchpad.md` a stable structure to
 * drive the cover → email → apply act flow.
 *
 * It NEVER writes the tracker. Status transitions belong to set-status.mjs
 * (the canonical, locked, validated write path). The only object launchpad may
 * write is data/launchpad-state.json (row numbers the user dismissed), and even
 * that only with an explicit --dismiss/--reedit call.
 *
 * Usage:
 *   node launchpad.mjs                  → human-readable tier view
 *   node launchpad.mjs --json           → machine-readable tier list
 *   node launchpad.mjs --summary        → one-line per-open row (all tiers)
 *   node launchpad.mjs --dismiss 8 16   → remember those rows as dismissed
 *   node launchpad.mjs --reedit 8       → forget a dismissed row
 *   node launchpad.mjs --self-test      → run the built-in test harness
 *
 * Exit codes: 0 ok · 1 usage/parse error · 2 not-found/bad selector ·
 * 4 state-file write failure.
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, renameSync } from 'fs';
import { resolveColumns, extractTrackerReportNumbers, isSeparatorRow, isHeaderRow } from './tracker-parse.mjs';
import { resolveTrackerPath } from './tracker-utils.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const statePath = join(__dir, 'data', 'launchpad-state.json');

// ── Tier thresholds. Sensible defaults; the launchpad.md mode adjusts these
// per the user's stated preference (and profile.yml launchpad: block) without
// the script needing a YAML parser. Read as constants for determinism/tests.
const THRESHOLDS = { act: 4.0, prep: 3.5 };

// ── Blocking-keyword detection (structural vs fixable) ───────────────────────
const STRUCTURAL_BLOCKER_RE = /\b(relocat|on-site|in-person|in-office|onsite|sponsorship|\bvisa\b|must\s+live|must\s+relocat|rebas|campus|hub\s+locat|require.{0,25}(?:locat|office|campus)|san\s+francisco|new\s+york|bay\s+area)\b/i;
// Language-requirement gates are structural ONLY when an actual language is
// named — bare "fluency"/"fluent" also appears in "AI-fluency" and "product
// fluency", which are not relocation/language blockers. The report's own
// language-required postings name Portuguese/Brazilian/etc.
const LANGUAGE_BLOCKER_RE = /\b(pt[-\s]?br|brasileiro|brazilian|portugu(?:ese|s)|spanish[-\s]?speaking|german[-\s]?speaking|dutch|danish|bilingual|fluent(?:ly)?\s+(?:in|in)?\s+(?:portugu|spanish|german|french|japanese|dr)\b|writing?\s+required.?\s*\b(?:portugu|spanish|german|french|japanese))/i;
const FIXABLE_BLOCKER_RE = /\b(portfolio|demo|github|open[-\s]source|artifact|public(?:ly)?|code\s+sample|case\s+study|write[-\s]?up|comp|compensation|salary|advertised|verify|tailor|cv|resume|frame)\b/i;

function readReportYaml(reportPath) {
  try {
    const text = readFileSync(reportPath, 'utf8');
    const fence = text.match(/```yaml\s*\r?\n([\s\S]*?)\r?\n```/);
    if (!fence) return {};
    const out = {};
    let listKey = null;
    for (const raw of fence[1].split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (!line.trim()) { listKey = null; continue; }
      if (/^\s{2,}\w+:/.test(line)) { listKey = null; continue; }
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (kv) { out[kv[1]] = stripQuotes(kv[2]); listKey = kv[1]; continue; }
      const item = line.match(/^\s*-\s+(.*)$/);
      if (item) { out[listKey] = out[listKey] || []; out[listKey].push(stripQuotes(item[1])); continue; }
      listKey = null;
    }
    return out;
  } catch { return {}; }
}
function stripQuotes(s) { const t = String(s).trim(); return t.replace(/^(["'])(.*)\1$/, '$2'); }

function tierFor(score, blocker) {
  if (score == null || score < THRESHOLDS.prep) return 'SKIP';
  if (blocker === 'structural') return 'HOLD';
  if (blocker === 'fixable') return 'PREP'; // fix the blocker before applying, even at high score
  if (score >= THRESHOLDS.act) return 'ACT';
  return 'PREP';
}

function classifyBlocker(yaml) {
  const soft = (Array.isArray(yaml.soft_gaps) ? yaml.soft_gaps : []).join(' ');
  const hard = (Array.isArray(yaml.hard_stops) ? yaml.hard_stops : []).join(' ');
  const all = `${hard} ${soft} ${yaml.final_decision || ''} ${yaml.advertised_comp || ''} ${yaml.next_action || ''}`;
  if (Array.isArray(yaml.hard_stops) && yaml.hard_stops.length > 0) return 'structural';
  if (STRUCTURAL_BLOCKER_RE.test(all)) return 'structural';
  if (LANGUAGE_BLOCKER_RE.test(all)) return 'structural';
  if (FIXABLE_BLOCKER_RE.test(all)) return 'fixable';
  return null;
}

function resolveReportPath(num) {
  const base = join(__dir, 'reports');
  if (!existsSync(base)) return null;
  try {
    const hit = readdirSync(base).find((f) => new RegExp(`^0*${num}-[^/]+\\.md$`, 'i').test(f));
    return hit ? join(base, hit) : null;
  } catch { return null; }
}

function computeLaunchpad(appsFile, dismissed) {
  const files = readFileSync(appsFile, 'utf8').split('\n');
  const colmap = resolveColumns(files);
  const rows = [];
  for (const line of files) {
    if (isSeparatorRow(line) || isHeaderRow(line)) continue;
    if (!line.trim()) continue;
    const parts = line.split('|').map((s) => s.trim());
    const num = parseInt(parts[colmap.num], 10);
    if (num === 0 || isNaN(num)) continue;
    const status = parts[colmap.status] ?? '';
    if (status.trim() !== 'Evaluated') continue;
    if (dismissed.includes(num)) continue;
    const scoreRaw = parts[colmap.score] ?? '';
    const score = scoreRaw.endsWith('/5') ? parseFloat(scoreRaw.replace(/\/5$/, '')) : null;
    const reportCell = parts[colmap.report] ?? '';
    const notes = parts[colmap.notes] ?? '';
    const reportNum = (extractTrackerReportNumbers(reportCell, notes)[0]) ?? num;
    const role = parts[colmap.role] ?? '';
    const isFixture = /test fixture|synthetic|calibrat/i.test(`${role} ${notes}`);
    if (isFixture) continue; // calibration/synthetic rows aren't actionable roles
    const rp = resolveReportPath(reportNum);
    const yaml = rp ? readReportYaml(rp) : {};
    const blocker = rp ? classifyBlocker(yaml) : null;
    rows.push({
      num, date: parts[colmap.date] ?? '', company: parts[colmap.company] ?? '',
      role: parts[colmap.role] ?? '', score, notes, reportNum, reportPath: rp ?? null,
      tier: tierFor(score, blocker), blocker,
      comp: yaml.advertised_comp ?? '', nextAction: yaml.next_action ?? '',
      hardStops: (yaml.hard_stops || []), softGaps: (yaml.soft_gaps || []),
    });
  }
  rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  return rows;
}

// ── state helpers ────────────────────────────────────────────────────────────
function readState() { try { return (JSON.parse(readFileSync(statePath, 'utf8')).dismissed) || []; } catch { return []; } }
function writeState(dismissed) {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    const tmp = `${statePath}.tmp${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ dismissed, updated: new Date().toISOString() }, null, 2));
    renameSync(tmp, statePath);
    return true;
  } catch { return false; }
}

// ── self-test ────────────────────────────────────────────────────────────────
function runSelfTest() {
  const checks = [
    ['tick 0.0 → SKIP', tierFor(0.0, null) === 'SKIP'],
    ['3.0 → SKIP', tierFor(3.0, null) === 'SKIP'],
    ['3.6 fixable → PREP', tierFor(3.6, 'fixable') === 'PREP'],
    ['4.1 none → ACT', tierFor(4.1, null) === 'ACT'],
    ['4.4 fixable → PREP (act gate blocked)', tierFor(4.4, 'fixable') === 'PREP'],
    ['4.4 structural → HOLD', tierFor(4.4, 'structural') === 'HOLD'],
    ['hard_stop → structural', classifyBlocker({ hard_stops: ['no sponsorship'], soft_gaps: [] }) === 'structural'],
    ['soft gap portfolio → fixable', classifyBlocker({ hard_stops: [], soft_gaps: ['no portfolio'], final_decision: 'Apply with a demo' }) === 'fixable'],
    ['no gap → null', classifyBlocker({ hard_stops: [], soft_gaps: [], final_decision: 'Apply' }) === null],
  ];
  let passCount = 0;
  for (const [name, ok] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name}`); if (ok) passCount++; }
  console.log(`\nlaunchpad self-test: ${passCount}/${checks.length} passed`);
  process.exit(passCount === checks.length ? 0 : 1);
}

// ── CLI entry ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes('--self-test')) runSelfTest();

const dismissed = readState();

const di = args.indexOf('--dismiss');
if (di !== -1) {
  const nums = args.slice(di + 1).filter((a) => !a.startsWith('-')).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (nums.length === 0) { console.error('Usage: node launchpad.mjs --dismiss <rowNums…>'); process.exit(2); }
  const merged = [...new Set([...dismissed, ...nums])];
  if (writeState(merged)) { console.log(`dismissed ${nums.join(', ')} — remembered across sessions`); process.exit(0); }
  console.error('failed to write launchpad-state.json'); process.exit(4);
}
const ri = args.indexOf('--reedit');
if (ri !== -1) {
  const nums = args.slice(ri + 1).filter((a) => !a.startsWith('-')).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const merged = dismissed.filter((x) => !nums.includes(x));
  if (writeState(merged)) { console.log(`un-dismissed ${nums.join(', ')}`); process.exit(0); }
  console.error('failed to write launchpad-state.json'); process.exit(4);
}

const appsFile = resolveTrackerPath(__dir);
const rows = computeLaunchpad(appsFile, dismissed);

if (args.includes('--json')) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
if (args.includes('--summary')) {
  for (const r of rows) console.log(`${pad(r.tier, 4)} #${pad(String(r.num), 3)} ${pad(r.score == null ? '—' : r.score.toFixed(1), 4)} ${r.company} · ${r.role}${r.blocker ? `  [${r.blocker}]` : ''}`);
  process.exit(0);
}

// human-readable grouped view
const groups = { ACT: [], PREP: [], HOLD: [], SKIP: [] };
for (const r of rows) groups[r.tier].push(r);
console.log('career-ops launchpad — open evaluated rows, priority-ordered\n');
for (const tier of ['ACT', 'PREP', 'HOLD', 'SKIP']) {
  const list = groups[tier];
  if (list.length === 0) continue;
  console.log(`${tierIcon(tier)} ${tier} · ${list.length}`);
  for (const r of list) {
    console.log(`   #${r.num} ${r.company} · ${r.role} · ${r.score == null ? '—' : r.score.toFixed(1) + '/5'}${r.blocker ? `  [${r.blocker}]` : ''}`);
    if (r.nextAction) console.log(`      → ${r.nextAction}`);
    if (r.blocker === 'structural') console.log(`      → keep open only if the blocker clears; mark SKIP with: node set-status.mjs ${r.num} SKIP`);
    else if (r.tier === 'ACT' && !r.blocker) console.log(`      → ready: node set-status.mjs ${r.num} Applied  (after you actually apply)`);
  }
  console.log('');
}
console.log(`${dismissed.length} dismissed (${dismissed.join(', ') || 'none'}) — --reedit to restore`);

function tierIcon(t) { return t === 'ACT' ? '🟢' : t === 'PREP' ? '🟠' : t === 'HOLD' ? '🟡' : '⚫'; }
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }