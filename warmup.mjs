// @ts-check
/**
 * warmup.mjs — the session-start "operating rhythm" digest.
 *
 * Instead of running launchpad, watch-deadlines, proof-point-bank, salary-trend
 * and doctor across separate calls and assembling them in your head, one call
 * synthesizes where you are and the fastest wins today:
 *
 *   1. health (doctor.mjs --json)
 *   2. actionable launchpad tiers (ACTIVE only)
 *   3. upcoming deadlines (watch-deadlines --json)
 *   4. proof-points needing work
 *   5. salary-trend fit vs your target
 *
 * Read-only aggregator; every figure comes from the existing zero-LLM scripts,
 * so nothing is recomputed or invented here.
 *
 * Usage:
 *   node warmup.mjs             → the full digest
 *   node warmup.mjs --fast      → skip the (slightly slower) salary trend
 *   node warmup.mjs --json      → machine-readable summary
 *   node warmup.mjs --self-test → verifies the aggregator reads
 */
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { execFileSync } from 'child_process';

const __dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function run(script, flags = []) {
  try { return execFileSync('node', [join(__dir, script), ...flags], { encoding: 'utf8', maxBuffer: (1 << 22) }).trim(); }
  catch { return ''; }
}
function runJson(script, flags = []) {
  const out = run(script, flags);
  try { return JSON.parse(out); } catch { return null; }
}

function proofStatus() {
  const p = join(__dir, 'data', 'proof-points.tsv');
  if (!existsSync(p)) return { unPub: 0, pub: 0 };
  const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(1);
  let unPub = 0, pub = 0;
  for (const l of lines) { const c = l.split('\t'); if (c[1] === 'published') pub++; else if (c[0]) unPub++; }
  return { unPub, pub };
}

if (args.includes('--self-test')) {
  const checks = [
    ['doctor resolves', run('doctor.mjs', ['--json']).includes('onboardingNeeded')],
    ['launchpad resolves', runJson('launchpad.mjs', ['--json']) !== null],
    ['watch-deadlines resolves', runJson('watch-deadlines.mjs', ['--json']) !== null],
  ];
  let n = 0;
  for (const [name, ok] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name}`); if (ok) n++; }
  console.log(`\nwarmup ${n}/${checks.length} passed`);
  process.exit(n === checks.length ? 0 : 1);
}

const doctor = runJson('doctor.mjs', ['--json']);
const launch = runJson('launchpad.mjs', ['--json']) || [];
const deadlines = runJson('watch-deadlines.mjs', ['--json']) || [];
const proofs = proofStatus();
const salary = args.includes('--fast') ? null : runJson('salary-trend.mjs', ['--json']);

if (args.includes('--json')) {
  console.log(JSON.stringify({ onboarded: !(doctor && doctor.onboardingNeeded), active: launch.filter((r) => r.tier === 'ACT' || r.tier === 'PREP').length, open: launch.length, deadlines: deadlines.length, proofs, salary: salary ? { families: salary.families || [] } : null }, null, 2));
  process.exit(0);
}

const active = launch.filter((r) => r.tier === 'ACT' || r.tier === 'PREP');
const urgent = deadlines.filter((d) => d.daysOut <= 7);
console.log('career-ops — session start (operating rhythm)');
console.log('──────────────────────────────');
console.log(`setup   ${doctor && doctor.onboardingNeeded ? '⚠ ONBOARDING NEEDED' : '✓ onboarded'}`);
console.log(`launch  ${active.length} ACTIVE (of ${launch.length} open evaluated) — node apply-queue.mjs`);
console.log(`deadline ${urgent.length} within 7d` + (urgent.length ? ' — node watch-deadlines.mjs' : ' ✓'));
console.log(`proofs  ${proofs.unPub} in progress · ${proofs.pub} published — node proof-point-bank.mjs`);
if (salary && salary.families && salary.families.length) {
  const fams = [...salary.families].sort((a, b) => b.count - a.count);
  const top = fams[0];
  console.log(`comp    ${top.family}: ${top.count} role(s) — advertised span $${top.min.toLocaleString('en-US')}–$${top.max.toLocaleString('en-US')} vs target`);
}
console.log('──────────────────────────────');
console.log('suggested sequence: launchpad → apply-queue → watch-deadlines');
process.exit(0);