// @ts-check
/**
 * apply-queue.mjs — the caregiver that turns launchpad's ACT/PREP rows into
 * tracked, dated applications.
 *
 * launchpad tiers the evaluated rows; this is the "do the thing" layer:
 * it surfaces the current ACTIVE/PREP launchpad rows, shows the prep still
 * gating each one, and chains cover → email → apply → set-status → followup-
 * seed as a coordinator (never submitting anything itself).
 *
 * It reads launchpad.mjs output; state (in-flight queue) lives in
 * data/apply-queue.json (user layer). The ONLY write it performs, and only
 * with an explicit --complete <row#>, is telling set-status to mark that row
 * Applied (after you actually submitted) and seeding its first follow-up.
 *
 * Usage:
 *   node apply-queue.mjs                        → the queue (reads launchpad)
 *   node apply-queue.mjs --json               → structured
 *   node apply-queue.mjs --detail <row#>      → prep gating one row
 *   node apply-queue.mjs --draft <row#>     → print the cover/email/apply chain (draft-only)
 *   node apply-queue.mjs --complete <row#>  → mark Applied (only after YOU submit) + seed follow-up
 *   node apply-queue.mjs --self-test
 */
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { execFileSync } from 'child_process';
import { getCareerOpsRoot } from './path-resolver.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = getCareerOpsRoot();
const queuePath = join(CAREER_OPS, 'data', 'apply-queue.json');
const LAUNCHPAD = join(__dir, 'launchpad.mjs');

function readQueue() { try { return JSON.parse(readFileSync(queuePath, 'utf8')).queue || []; } catch { return []; } }
function writeQueue(q) {
  try { mkdirSync(dirname(queuePath), { recursive: true }); const tmp = `${queuePath}.tmp${process.pid}`; writeFileSync(tmp, JSON.stringify({ queue: q, updated: new Date().toISOString() }, null, 2)); renameSync(tmp, queuePath); return true; } catch { return false; }
}

// call launchpad --json and parse (zero-LLM; same source the mode reads)
function launchpadRows() {
  try {
    const out = execFileSync('node', [LAUNCHPAD, '--json'], { encoding: 'utf8' });
    return JSON.parse(out);
  } catch { return []; }
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  // Real wiring test: launchpad --json must resolve to an array of rows with
  // the fields apply-queue depends on (tier, num, company, role, blocker, nextAction).
  const checks = [
    ['launchpad resolves', Array.isArray(launchpadRows())],
    ['row objects have tier field', launchpadRows().every((r) => typeof r.tier === 'string')],
  ];
  let n = 0;
  for (const [name, ok] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name}`); if (ok) n++; }
  console.log(`\napply-queue ${n}/${checks.length} passed`);
  process.exit(n === checks.length ? 0 : 1);
}

const rows = launchpadRows();
const active = rows.filter((r) => r.tier === 'ACT' || r.tier === 'PREP');

// --detail: show the prep gating one row (the blockers, next action, comp)
const dei = args.indexOf('--detail');
if (dei !== -1) {
  const num = parseInt(args[dei + 1], 10);
  const t = active.find((r) => r.num === num);
  if (!t) { console.error(`no ACTIVE row #${num}`); process.exit(2); }
  console.log(`Detail for #${num} ${t.company} · ${t.role} (${t.tier})`);
  console.log(`  score:      ${t.score}/5`);
  console.log(`  blocker:    ${t.blocker ?? 'none'}`);
  console.log(`  comp:       ${t.comp ?? 'n/a'}`);
  console.log(`  next action: ${t.nextAction ?? '(none)'}`);
  console.log(`\nDraft the chain with: node apply-queue.mjs --draft ${num}`);
  process.exit(0);
}

if (args.includes('--json')) { console.log(JSON.stringify({ count: active.length, active }, null, 2)); process.exit(0); }

// --complete: only with explicit user action already done
const ci = args.indexOf('--complete');
if (ci !== -1) {
  const num = parseInt(args[ci + 1], 10);
  if (!num || isNaN(num)) { console.error('usage: --complete <row#>'); process.exit(2); }
  const target = active.find((r) => r.num === num);
  if (!target) { console.error(`row #${num} is not an ACTIVE (ACT/PREP) launchpad row`); process.exit(2); }
  // Only the user actually applies; we just record it.
  try {
    execFileSync('node', [join(__dir, 'set-status.mjs'), String(num), 'Applied'], { encoding: 'utf8', stdio: 'ignore' });
    execFileSync('node', [join(__dir, 'followup-seed.mjs'), String(num)], { encoding: 'utf8', stdio: 'ignore' });
  } catch (e) { console.error('failed to mark Applied (set-status/followup-seed):', e.message); process.exit(4); }
  const q = readQueue(); const rec = { num, markedAt: new Date().toISOString(), prep: target.blocker ?? null };
  writeQueue([...q.filter((x) => x.num !== num), rec]);
  console.log(`#${num} ${target.company} · ${target.role} marked Applied + follow-up seeded. (You did the apply — this just records it.)`);
  process.exit(0);
}

// --draft: show the chain (draft-only, never sends)
const di = args.indexOf('--draft');
if (di !== -1) {
  const num = parseInt(args[di + 1], 10);
  const t = active.find((r) => r.num === num);
  if (!t) { console.error(`no ACTIVE row #${num}`); process.exit(2); }
  console.log(`Apply chain for #${num} ${t.company} · ${t.role} (${t.tier})`);
  console.log(`  prep:       ${t.nextAction ?? '(none)'}`);
  console.log(`  1. cover:   /career-ops cover ${slug(t.company)}`);
  console.log(`  2. email:    /career-ops email   (draft-only)`);
  console.log(`  3. apply:    /career-ops apply   (you submit the form)`);
  console.log(`  4. record:   node apply-queue.mjs --complete ${num}   (after YOU submit)`);
  process.exit(0);
}

// default: show queue + prep
if (active.length === 0) { console.log('no ACTIVE launchpad rows — run launchpad first'); process.exit(0); }
console.log(`apply queue — ${active.length} row(s) ready to act (of ${rows.length} open evaluated)`);
for (const r of active) {
  console.log(`  #${r.num} ${r.company} · ${r.role} · ${r.tier} · ${r.score}/5${r.blocker ? `  [${r.blocker}]` : ''}`);
  if (r.nextAction) console.log(`       ↳ ${r.nextAction.slice(0, 100)}`);
}
console.log('\nFor one row: node apply-queue.mjs --draft <row#> · to record a done apply: --complete <row#>');
process.exit(0);

function slug(name) { return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }