// @ts-check
/**
 * rejection-reset.mjs — make the toolkit self-renewing after a rejection.
 *
 * When a row moves past Evaluated (or explicitly to Rejected), nothing clears
 * its launchpad state or re-files the gap. This small coordinator:
 *   1. detects rows that recently went Rejected (or `--row <#> --status Rejected`),
 *   2. prints the close-loop proposal (the CV/prep edit that rejection points to),
 *   3. with `--reset <rowNums…>`, dismisses a row the user chose to drop after
 *      rejection so launchpad stops surfacing it.
 *
 * It never edits cv.md or _profile.md itself — close-loop only proposes (the
 * mode writes with your confirmation). It never touches the tracker: the only
 * file it may write is `data/launchpad-state.json`, and only under the explicit
 * `--reset` flag.
 *
 * An `--apply` that "recorded the fix task" was documented here but never
 * implemented. It is trimmed rather than invented: the only shared state file is
 * rewritten wholesale by launchpad.mjs as `{ dismissed }`, so fix tasks stored
 * there would be dropped on launchpad's next write.
 *
 * Usage:
 *   node rejection-reset.mjs                        → scan for recently-rejected rows
 *   node rejection-reset.mjs --row 42              → proposal for #42
 *   node rejection-reset.mjs --row 42 --json       → structured
 *   node rejection-reset.mjs --reset 42 58         → dismiss those rows in launchpad-state.json
 *   node rejection-reset.mjs --self-test
 *
 * Exit codes: 0 ok · 1 usage error · 4 state-file write failure.
 */
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { execFileSync } from 'child_process';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = getCareerOpsRoot();
const statePath = join(CAREER_OPS, 'data', 'launchpad-state.json');
// Same resolver close-loop.mjs (the child we spawn) uses: honoring
// CAREER_OPS_TRACKER and the <root>/applications.md layout keeps the two
// scripts reading one file instead of two.
const apps = resolveTrackerPath(CAREER_OPS);

function readState() { try { return (JSON.parse(readFileSync(statePath, 'utf8')).dismissed) || []; } catch { return []; } }
function writeState(dismissed) {
  try { mkdirSync(dirname(statePath), { recursive: true }); const tmp = `${statePath}.tmp${process.pid}`; writeFileSync(tmp, JSON.stringify({ dismissed }, null, 2)); renameSync(tmp, statePath); return true; } catch { return false; }
}
/** Parse tracker table text into rows. Column 1 is the row number, 1-based. */
function parseRows(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const p = line.split('|').map((s) => s.trim());
    const n = parseInt(p[1], 10);
    // Also rejects the header and the `|---|` separator: both parse to NaN,
    // which the old `n === 0` test let through as a tracker row.
    if (!Number.isInteger(n) || n === 0) continue;
    out.push({ num: n, company: p[3] ?? '', role: p[4] ?? '', status: p[6] ?? '', notes: p[9] ?? '' });
  }
  return out;
}
function trackerRows() {
  if (!existsSync(apps)) return [];
  return parseRows(readFileSync(apps, 'utf8'));
}

function closeLoopRow(num) {
  // Reuse close-loop.mjs to propose the CV/prep edit for a row. A failed child
  // returns { ok: false } rather than an empty string: swallowed, the blank
  // gap/target would read as "close-loop found no gap" when it never answered.
  try {
    return { ok: true, text: execFileSync('node', [join(__dir, 'close-loop.mjs'), String(num)], { encoding: 'utf8', maxBuffer: (1 << 22) }).trim() };
  } catch (e) {
    const tail = String(e.stderr || e.message || '').trim().split('\n').filter(Boolean).pop();
    return { ok: false, error: tail || 'unknown error' };
  }
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  // Both old checks were true by construction — readState() and trackerRows()
  // swallow every error and still return an array — so a broken parser could
  // not fail this harness. These drive the parser against a literal tracker.
  const FIXTURE = [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|---|---|---|---|---|---|---|---|',
    '| 7 | 2026-01-05 | Acme | Staff Engineer | 4.0/5 | Rejected | ❌ | [7](r.md) | n |',
    '',
  ].join('\n');
  const parsed = parseRows(FIXTURE);
  const checks = [
    ['header and separator rows are skipped', parsed.length === 1],
    ['row fields map to num/company/status',
      parsed[0]?.num === 7 && parsed[0]?.company === 'Acme' && parsed[0]?.status === 'Rejected'],
  ];
  let n = 0;
  for (const [name, ok] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name}`); if (ok) n++; }
  console.log(`\nrejection-reset ${n}/${checks.length} passed`);
  process.exit(n === checks.length ? 0 : 1);
}

const ri = args.indexOf('--row');
const statusMaybe = args.indexOf('--status') !== -1 ? args[args.indexOf('--status') + 1] : null;
const selNum = ri !== -1 ? parseInt(args[ri + 1], 10) : null;
const asJson = args.includes('--json');
const resetIdx = args.indexOf('--reset');
const resetNums = resetIdx !== -1
  ? args.slice(resetIdx + 1).filter((a) => !a.startsWith('-')).map(Number).filter((n) => Number.isInteger(n) && n > 0)
  : [];

if (resetIdx !== -1 && resetNums.length === 0) {
  console.error('Usage: node rejection-reset.mjs --reset <rowNums…>');
  process.exit(1);
}

// --reset: the single write this script may make (a row the user chose to drop).
if (resetIdx !== -1) {
  const merged = [...new Set([...readState(), ...resetNums])];
  if (!writeState(merged)) { console.error(`failed to write ${statePath}`); process.exit(4); }
  console.log(`dismissed ${resetNums.join(', ')} in launchpad-state.json — launchpad will stop surfacing ${resetNums.length === 1 ? 'that row' : 'those rows'}`);
  process.exit(0);
}

const rows = trackerRows();
const candidates = selNum
  ? rows.filter((r) => r.num === selNum)
  : rows.filter((r) => /reject/i.test(r.status));

const payload = (list) => JSON.stringify({ candidates: list }, null, 2);

if (candidates.length === 0) {
  if (asJson) { console.log(payload([])); process.exit(0); }
  console.log(selNum ? `no tracker row #${selNum}` : 'no rejected rows in the tracker');
  process.exit(0);
}
const proposals = candidates.map((c) => {
  const prop = closeLoopRow(c.num);
  // Surface a failed child instead of a blank proposal: blank gap/target read
  // as "no gap found".
  if (!prop.ok) return { ...c, failed: true, gap: `(close-loop failed: ${prop.error})`, target: '' };
  const pick = (key) => {
    const line = prop.text.split('\n').find((s) => s.includes(key)) || '';
    return line.replace(new RegExp(`^\\s*.*${key}\\s*`), '').slice(0, 90);
  };
  return { ...c, gap: pick('gap:'), target: pick('target:') };
});

if (asJson) { console.log(payload(proposals)); process.exit(0); }

for (const c of proposals) {
  console.log(`\n#${c.num} ${c.company} · ${c.role} [${c.status}]`);
  if (c.failed) {
    console.log(`  ${c.gap}`);
  } else {
    console.log(`  close-loop gap:    ${c.gap}`);
    console.log(`  close-loop target: ${c.target}`);
  }
  console.log('  launchpad  - row left open or PREP as-is; if you drop it: add to dismissed');
  if (statusMaybe === 'Rejected') console.log(`  (rejection recorded for ${c.num} — re-run launchpad to refresh tiers)`);
}
console.log('\nrejection-reset is advisory — it never edits cv.md/_profile.md or the tracker.');
process.exit(0);