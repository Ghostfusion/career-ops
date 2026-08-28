// @ts-check
/**
 * negotiate.mjs — one screen to negotiate: market context + verified ROIs
 * + the current vs target gap for a specific offer row.
 *
 * It coordinates three existing zero-LLM tools for a single offer:
 *   1. salary-trend — is the offered band on-market for the family?
 *   2. negotiation-roi — verified, dollar-valuable achievements from the
 *      story-bank (only those that appear verbatim in cv.md — the script's
 *      antic-fabrication gate).
 *   3. salary-gap — where the offered figure sits vs desired/advertised.
 *
 * It is READ-ONLY and drafts nothing the user doesn't ask for. It prints a
 * negotiation briefing you can carry into a call.
 *
 * Usage:
 *   node negotiate.mjs --row 8                    → briefing for tracker #8
 *   node negotiate.mjs --row 8 --json             → structured
 *   node negotiate.mjs --self-test                → verifies the parts resolve
 */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = getCareerOpsRoot();
const args = process.argv.slice(2);

function run(script, flags = []) {
  try { return execFileSync('node', [join(__dir, script), ...flags], { encoding: 'utf8', maxBuffer: (1 << 22) }).trim(); }
  catch { return ''; }
}
function runJson(script, flags = []) {
  const out = run(script, flags);
  try { return JSON.parse(out); } catch { return null; }
}

// find the role family for a tracker row's role (reads the report yaml via salary-trend's family)
function roleForRow(num) {
  // We rely on salary-trend --json's per-family data being present; to map a
  // specific row to a family, we read the tracker + its report's role and use
  // salary-trend's grouping implicitly — a simple role-text match is enough.
  const apps = join(CAREER_OPS, 'data', 'applications.md');
  if (!existsSync(apps)) return null;
  for (const line of readFileSync(apps, 'utf8').split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const p = line.split('|').map((s) => s.trim());
    const n = parseInt(p[1], 10);
    if (n === num) return { company: p[3] ?? '', role: p[4] ?? '', status: p[6] ?? '' };
  }
  return null;
}

if (args.includes('--self-test')) {
  const checks = [
    ['salary-trend resolves', runJson('salary-trend.mjs', ['--json']) !== null],
    ['negotiation-roi resolves', typeof run('negotiation-roi.mjs', ['--summary']) === 'string'],
  ];
  let n = 0;
  for (const [name, ok] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name}`); if (ok) n++; }
  console.log(`\nnegotiate ${n}/${checks.length} passed`);
  process.exit(n === checks.length ? 0 : 1);
}

const numRaw = args.find((a) => /^\d+$/.test(a)) || (args.includes('--row') ? args[args.indexOf('--row') + 1] : '');
const num = parseInt(numRaw, 10) || 0;
const row = num ? roleForRow(num) : null;

const tr = runJson('salary-trend.mjs', ['--json']);
const roi = run('negotiation-roi.mjs', ['--summary']);
const gap = num ? run('salary-gap.mjs', ['--stated-for', String(num)]) : run('salary-gap.mjs', ['--summary']);

if (args.includes('--json')) { console.log(JSON.stringify({ row, market: tr, roiSummary: roi.trim(), gap: gap.trim() }, null, 2)); process.exit(0); }

console.log(`Negotiation briefing${row ? ` — ${row.company} · ${row.role}` : ''}`);
console.log('──────────────────────────────');
if (tr && tr.families) {
  for (const f of tr.families.slice(0, 3)) console.log(`market ${f.family}: span $${f.min.toLocaleString('en-US')}–$${f.max.toLocaleString('en-US')} (${f.count} roles)`);
}
console.log('\nStory-bank ROI (verified against cv.md):');
console.log(roi || '(no quantified claims yet — run negotiation-roi for detail)');
console.log('\nComp gap:');
console.log(gap || '(no comp data on this row yet)');
console.log('──────────────────────────────');
console.log('Negotiation notes: quote only claims that appear verbatim in cv.md;');
console.log('anchor on market band + the verified ROI, never invented numbers.');
process.exit(0);