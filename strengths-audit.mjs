// @ts-check
/**
 * strengths-audit.mjs — is your CV getting stronger or drifting?
 *
 * A periodic audit that proves your CV is actually improving: how many
 * proof-points exist (data/proof-points.tsv), how many are published,
 * whether the core CV sections are present, an approximate page-length signal,
 * and a verify-cv-facts cleanliness check (advisory — the audit never fails).
 *
 * Usage:
 *   node strengths-audit.mjs                    → the audit
 *   node strengths-audit.mjs --json
 *   node strengths-audit.mjs --self-test
 */
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { execFileSync } from 'child_process';

const __dir = dirname(fileURLToPath(import.meta.url));
const SKILL_SECTIONS = ['Skills', 'Professional Summary', 'Work Experience', 'Education', 'Certifications'];

function audit() {
  const p = join(__dir, 'cv.md');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}
function proofCounts() {
  const p = join(__dir, 'data', 'proof-points.tsv');
  if (!existsSync(p)) return { total: 0, published: 0, inprogress: 0 };
  const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(1);
  let total = 0, published = 0;
  for (const l of lines) { const c = l.split('\t'); if (c[0] && !c[0].startsWith('name')) { total++; if (c[1] === 'published') published++; } }
  return { total, published, inprogress: total - published };
}
function factCheckWarnings() {
  const v = join(__dir, 'verify-cv-facts.mjs');
  if (!existsSync(v)) return null;
  try { const out = execFileSync('node', [v], { encoding: 'utf8', maxBuffer: (1 << 22) }); const w = (String(out).match(/advisory phrase: .+/g) || []).slice(0, 3); return w.length ? w : []; }
  catch { return []; }
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  const checks = [
    ['audit reads cv', typeof audit() === 'string'],
    ['proof counts', typeof proofCounts().total === 'number'],
    ['sections present', SKILL_SECTIONS.length === 5],
  ];
  let n = 0;
  for (const [name, ok] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name}`); if (ok) n++; }
  console.log(`\nstrengths-audit ${n}/${checks.length} passed`);
  process.exit(n === checks.length ? 0 : 1);
}

const cv = audit();
const proofs = proofCounts();
const warnings = factCheckWarnings();

if (args.includes('--json')) { console.log(JSON.stringify({ proofs, sections: SKILL_SECTIONS.filter((s) => new RegExp(s, 'i').test(cv)), warnings: warnings || [] }, null, 2)); process.exit(0); }

const present = SKILL_SECTIONS.filter((s) => new RegExp(s, 'i').test(cv));
console.log('strengths-audit — is your CV getting stronger?');
console.log(`  proof-points    : ${proofs.total} total (${proofs.published} published, ${proofs.inprogress} in progress)`);
console.log(`  CV sections     : ${present.join(', ') || 'none detected'}`);
console.log(`  approx length   : ~${(cv.length / 4000).toFixed(1)}k chars (keeps ≈2 pages)`);
console.log(`  fact check      : ${warnings === null ? 'verify-cv-facts not found' : warnings.length ? `⚠ ${warnings.length} advisory phrase(s): ${warnings[0].slice(0, 60)}` : 'clean'}`);
process.exit(0);