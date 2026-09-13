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
import { getCareerOpsRoot } from './path-resolver.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = getCareerOpsRoot();
const SKILL_SECTIONS = ['Skills', 'Professional Summary', 'Work Experience', 'Education', 'Certifications'];

function audit() {
  const p = join(CAREER_OPS, 'cv.md');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}
function sectionsIn(cv) {
  return SKILL_SECTIONS.filter((s) => new RegExp(s, 'i').test(cv));
}
function parseProofPoints(text) {
  const lines = text.split('\n').filter(Boolean).slice(1);
  let total = 0, published = 0;
  for (const l of lines) { const c = l.split('\t'); if (c[0] && !c[0].startsWith('name')) { total++; if (c[1] === 'published') published++; } }
  return { total, published, inprogress: total - published };
}
function proofCounts() {
  const p = join(CAREER_OPS, 'data', 'proof-points.tsv');
  return existsSync(p) ? parseProofPoints(readFileSync(p, 'utf8')) : { total: 0, published: 0, inprogress: 0 };
}
// verify-cv-facts takes a positional document and carries its advisory phrases
// only inside --json's payload, so the old call — no target (usage + exit 1,
// swallowed by a bare catch) plus a stdout grep for a phrase the tool writes to
// stderr — reported "clean" no matter what, including with no cv.md at all.
// cwd is the data root so the tool's default sources resolve against the same
// tree as the target.
function factCheck() {
  const tool = join(__dir, 'verify-cv-facts.mjs');
  const cvPath = join(CAREER_OPS, 'cv.md');
  if (!existsSync(tool)) return { ran: false, reason: 'verify-cv-facts not found', verdict: null, warnings: [] };
  if (!existsSync(cvPath)) return { ran: false, reason: 'no cv.md to check', verdict: null, warnings: [] };
  let payload = null;
  try {
    payload = JSON.parse(execFileSync(process.execPath, [tool, cvPath, '--json'], {
      cwd: CAREER_OPS, encoding: 'utf8', maxBuffer: (1 << 22), stdio: ['ignore', 'pipe', 'ignore'],
    }));
  } catch (err) {
    // A blocking verdict still writes its payload to stdout and exits 1.
    try { payload = JSON.parse(String(err.stdout || '')); } catch { payload = null; }
  }
  if (!payload) return { ran: false, reason: 'verify-cv-facts failed to run', verdict: null, warnings: [] };
  return { ran: true, reason: null, verdict: payload.verdict ?? null, warnings: Array.isArray(payload.warnings) ? payload.warnings : [] };
}
// "clean" is reserved for a check that ran and came back pass: a check that did
// not run must never read as clean.
function factCheckLine(fc) {
  if (!fc.ran) return `not run — ${fc.reason}`;
  if (fc.warnings.length) return `⚠ ${fc.warnings.length} advisory phrase(s): ${fc.warnings[0].slice(0, 60)}`;
  if (fc.verdict === 'pass') return 'clean';
  return `⚠ verify-cv-facts verdict: ${fc.verdict} — run verify-cv-facts.mjs for detail`;
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  // Fixture-fed on purpose: the previous three checks (typeof on a possibly
  // empty read, typeof on a count, and the length of a hard-coded literal) were
  // true by construction, so a broken parse could never show up here.
  const parsed = parseProofPoints(['name\tstatus', 'talk\tpublished', 'post\tdraft', ''].join('\n'));
  const checks = [
    ['cv readable', audit().length > 0],
    ['proof-points parsed', parsed.total === 2 && parsed.published === 1 && parsed.inprogress === 1],
    ['fact-check status honest', factCheckLine({ ran: false, reason: 'no cv.md to check', verdict: null, warnings: [] }) !== 'clean'
      && factCheckLine({ ran: true, reason: null, verdict: 'pass', warnings: [] }) === 'clean'],
  ];
  let n = 0;
  for (const [name, ok] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name}`); if (ok) n++; }
  console.log(`\nstrengths-audit ${n}/${checks.length} passed`);
  process.exit(n === checks.length ? 0 : 1);
}

const cv = audit();
const proofs = proofCounts();
const fact = factCheck();

if (args.includes('--json')) { console.log(JSON.stringify({ proofs, sections: sectionsIn(cv), warnings: fact.warnings, factCheck: { ran: fact.ran, verdict: fact.verdict } }, null, 2)); process.exit(0); }

const present = sectionsIn(cv);
console.log('strengths-audit — is your CV getting stronger?');
console.log(`  proof-points    : ${proofs.total} total (${proofs.published} published, ${proofs.inprogress} in progress)`);
console.log(`  CV sections     : ${present.join(', ') || 'none detected'}`);
console.log(`  approx length   : ~${(cv.length / 4000).toFixed(1)}k chars (keeps ≈2 pages)`);
console.log(`  fact check      : ${factCheckLine(fact)}`);
process.exit(0);