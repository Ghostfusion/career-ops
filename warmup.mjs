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
 * Not read-only: step 1 runs doctor.mjs --json, and doctor copies any missing
 * user-layer templates (modes/_profile.md, modes/_custom.md, modes/_brief.md,
 * voice-dna.md) into the data root before it answers, reporting them as
 * `autoCopied`. Those copies are surfaced in the digest and the --json payload,
 * so a write the user did not ask for is visible instead of silent. Every other
 * figure comes from the existing zero-LLM scripts; nothing is recomputed or
 * invented here.
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
import { getCareerOpsRoot } from './path-resolver.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = getCareerOpsRoot();
const args = process.argv.slice(2);

function run(script, flags = []) {
  // A crashed child is distinguishable from an empty success: the digest must
  // say "unknown", not render a failure as a zero count.
  try {
    return { ok: true, out: execFileSync('node', [join(__dir, script), ...flags], { encoding: 'utf8', maxBuffer: (1 << 22) }).trim() };
  } catch (e) {
    const tail = String(e.stderr || e.message || '').trim().split('\n').filter(Boolean).pop();
    return { ok: false, error: tail || 'unknown error' };
  }
}
function runJson(script, flags = []) {
  const r = run(script, flags);
  if (!r.ok) return null;
  try { return JSON.parse(r.out); } catch { return null; }
}

function proofStatus() {
  const p = join(CAREER_OPS, 'data', 'proof-points.tsv');
  if (!existsSync(p)) return { unPub: 0, pub: 0 };
  const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(1);
  let unPub = 0, pub = 0;
  for (const l of lines) { const c = l.split('\t'); if (c[1] === 'published') pub++; else if (c[0]) unPub++; }
  return { unPub, pub };
}

if (args.includes('--self-test')) {
  const doctorRun = run('doctor.mjs', ['--json']);
  const checks = [
    ['doctor resolves', doctorRun.ok && doctorRun.out.includes('onboardingNeeded')],
    ['launchpad resolves', runJson('launchpad.mjs', ['--json']) !== null],
    ['watch-deadlines resolves', runJson('watch-deadlines.mjs', ['--json']) !== null],
  ];
  let n = 0;
  for (const [name, ok] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name}`); if (ok) n++; }
  console.log(`\nwarmup ${n}/${checks.length} passed`);
  process.exit(n === checks.length ? 0 : 1);
}

const doctor = runJson('doctor.mjs', ['--json']);
const launch = runJson('launchpad.mjs', ['--json']);
const deadlines = runJson('watch-deadlines.mjs', ['--json']);
const proofs = proofStatus();
const salary = args.includes('--fast') ? null : runJson('salary-trend.mjs', ['--json']);
const autoCopied = Array.isArray(doctor?.autoCopied) ? doctor.autoCopied : [];

if (args.includes('--json')) {
  console.log(JSON.stringify({
    // null (not false) while doctor did not answer: onboarding cannot be claimed.
    onboarded: doctor ? !doctor.onboardingNeeded : null,
    autoCopied,
    // null while the source failed: a crash is unknown, not a zero count.
    active: launch ? launch.filter((r) => r.tier === 'ACT' || r.tier === 'PREP').length : null,
    open: launch ? launch.length : null,
    deadlines: deadlines ? deadlines.length : null,
    proofs,
    salary: salary ? { families: salary.families || [] } : null,
  }, null, 2));
  process.exit(0);
}

const active = launch ? launch.filter((r) => r.tier === 'ACT' || r.tier === 'PREP') : [];
const urgent = deadlines ? deadlines.filter((d) => d.daysOut <= 7) : [];
console.log('career-ops — session start (operating rhythm)');
console.log('──────────────────────────────');
console.log(`setup   ${!doctor ? '⚠ doctor failed — onboarding state unknown' : doctor.onboardingNeeded ? '⚠ ONBOARDING NEEDED' : '✓ onboarded'}`);
if (autoCopied.length) console.log(`        doctor copied missing templates: ${autoCopied.join(', ')}`);
console.log(`launch  ${!launch ? '⚠ launchpad failed — tier counts unknown' : `${active.length} ACTIVE (of ${launch.length} open evaluated) — node apply-queue.mjs`}`);
console.log(`deadline ${!deadlines ? '⚠ watch-deadlines failed — deadline count unknown' : `${urgent.length} within 7d${urgent.length ? ' — node watch-deadlines.mjs' : ' ✓'}`}`);
console.log(`proofs  ${proofs.unPub} in progress · ${proofs.pub} published — node proof-point-bank.mjs`);
if (salary && salary.families && salary.families.length) {
  const fams = [...salary.families].sort((a, b) => b.count - a.count);
  const top = fams[0];
  // Only promise the comparison when salary-trend actually returned a target.
  const band = salary.target
    ? ` vs target $${salary.target[0].toLocaleString('en-US')}–$${salary.target[1].toLocaleString('en-US')}`
    : '';
  console.log(`comp    ${top.family}: ${top.count} role(s) — advertised span $${top.min.toLocaleString('en-US')}–$${top.max.toLocaleString('en-US')}${band}`);
}
console.log('──────────────────────────────');
console.log('suggested sequence: launchpad → apply-queue → watch-deadlines');
process.exit(0);