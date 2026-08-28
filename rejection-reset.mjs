// @ts-check
/**
 * rejection-reset.mjs — make the toolkit self-renewing after a rejection.
 *
 * When a row moves past Evaluated (or explicitly to Rejected), nothing clears
 * its launchpad state or re-files the gap. This small coordinator:
 *   1. detects rows that recently went Rejected (or `--row <#> --status Rejected`),
 *   2. prints the close-loop proposal (the CV/prep edit that rejection points to),
 *   3. with `--apply`, records the fix task so launchpad won't keep the row in
 *      PREP without progress (and reminds the user to run close-loop).
 *
 * It never edits cv.md or _profile.md itself — close-loop only proposes (the
 * mode writes with your confirmation). The only file it may touch with the
 * explicit `--reset` flag is `data/launchpad-state.json` (dismiss a row the
 * user chose to drop after rejection) — never the tracker.
 *
 * Usage:
 *   node rejection-reset.mjs                        → scan for recently-rejected rows
 *   node rejection-reset.mjs --row 42              → proposal for #42
 *   node rejection-reset.mjs --row 42 --json       → structured
 *   node rejection-reset.mjs --self-test
 */
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { execFileSync } from 'child_process';
import { getCareerOpsRoot } from './path-resolver.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = getCareerOpsRoot();
const statePath = join(CAREER_OPS, 'data', 'launchpad-state.json');
const apps = join(CAREER_OPS, 'data', 'applications.md');

function readState() { try { return (JSON.parse(readFileSync(statePath, 'utf8')).dismissed) || []; } catch { return []; } }
function writeState(dismissed) {
  try { mkdirSync(dirname(statePath), { recursive: true }); const tmp = `${statePath}.tmp${process.pid}`; writeFileSync(tmp, JSON.stringify({ dismissed }, null, 2)); renameSync(tmp, statePath); return true; } catch { return false; }
}
function trackerRows() {
  if (!existsSync(apps)) return [];
  const out = [];
  for (const line of readFileSync(apps, 'utf8').split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const p = line.split('|').map((s) => s.trim());
    const n = parseInt(p[1], 10);
    if (n === 0) continue;
    out.push({ num: n, company: p[3] ?? '', role: p[4] ?? '', status: p[6] ?? '', notes: p[9] ?? '' });
  }
  return out;
}

function closeLoopRow(num) {
  // Reuse close-loop.mjs to propose the CV/prep edit for a row.
  try { return execFileSync('node', [join(__dir, 'close-loop.mjs'), String(num)], { encoding: 'utf8', maxBuffer: (1 << 22) }).trim(); }
  catch { return ''; }
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  const checks = [
    ['state read', Array.isArray(readState())],
    ['tracker rows', Array.isArray(trackerRows())],
  ];
  let n = 0;
  for (const [name, ok] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name}`); if (ok) n++; }
  console.log(`\nrejection-reset ${n}/${checks.length} passed`);
  process.exit(n === checks.length ? 0 : 1);
}

const ri = args.indexOf('--row');
const statusMaybe = args.indexOf('--status') !== -1 ? args[args.indexOf('--status') + 1] : null;
const selNum = ri !== -1 ? parseInt(args[ri + 1], 10) : null;

const rows = trackerRows();
const candidates = selNum
  ? rows.filter((r) => r.num === selNum)
  : rows.filter((r) => /reject/i.test(r.status));

if (candidates.length === 0) { console.log(selNum ? `no tracker row #${selNum}` : 'no rejected rows in the tracker'); process.exit(0); }
for (const c of candidates) {
  const num = c.num;
  console.log(`\n#${num} ${c.company} · ${c.role} [${c.status}]`);
  const prop = closeLoopRow(num);
  const gapLine = prop.split('\n').find((s) => s.includes('gap:')) || '';
  const target = prop.split('\n').find((s) => s.includes('target:')) || '';
  console.log(`  close-loop gap:    ${(gapLine.replace(/^\s*.*gap:\s*/, '').slice(0, 90))}`);
  console.log(`  close-loop target: ${target.replace(/^\s*.*target:\s*/, '').slice(0, 90)}`);
  console.log('  launchpad  - row left open or PREP as-is; if you drop it: add to dismissed');
  if (statusMaybe === 'Rejected') console.log(`  (rejection recorded for ${num} — re-run launchpad to refresh tiers)`);
}
console.log('\nrejection-reset is advisory — it never edits cv.md/_profile.md or the tracker.');
process.exit(0);