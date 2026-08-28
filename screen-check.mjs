// @ts-check
/**
 * screen-check.mjs — would you clear the resume screen for a tracker row?
 *
 * The real barrier between an evaluation and a phone call is the ATS screen,
 * not the subjective score. This folds the report's Machine Summary
 * (hard_stops / soft_gaps / final_decision) + the JD skill-gap (via
 * jd-skill-gap.mjs) into a pass / marginal / fail verdict per open row, and
 * says which specific bar kills it.
 *
 * It is a decision aid, not a guarantee — screen outcomes vary by recruiter.
 * It never writes anything.
 *
 * Usage:
 *   node screen-check.mjs                      → all open rows, screen verdicts
 *   node screen-check.mjs --row 8              → one row
 *   node screen-check.mjs --json               → structured
 *   node screen-check.mjs --self-test
 */
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { execFileSync } from 'child_process';
import { resolveColumns, isSeparatorRow, isHeaderRow } from './tracker-parse.mjs';
import { resolveTrackerPath } from './tracker-utils.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = getCareerOpsRoot();

// ── report YAML (shared shape with launchpad / salary-trend) ─────────────────
function yamlOf(reportPath) {
  try {
    const t = readFileSync(reportPath, 'utf8');
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

function resolveReport(num) {
  const base = join(CAREER_OPS, 'reports');
  if (!existsSync(base)) return null;
  try {
    const hit = readdirSync(base).find((f) => new RegExp(`^0*${num}-[^/]+\\.md$`, 'i').test(f));
    return hit ? join(base, hit) : null;
  } catch { return null; }
}

// Derive a candidate jds/ file from the report filename's leading company slug.
function resolveJdPath(reportPath) {
  if (!reportPath) return null;
  const file = reportPath.split(/[\\/]/).pop() || '';
  const rest = file.replace(/^0*\d+-/, '');
  const companyPart = rest.split('-')[0];
  if (!companyPart) return null;
  const base = join(__dir, 'jds');
  if (!existsSync(base)) return null;
  try {
    const hit = readdirSync(base).find((f) => f.startsWith(companyPart + '-'));
    return hit ? join(base, hit) : null;
  } catch { return null; }
}

// ── screen verdict ───────────────────────────────────────────────────────────
function verdictFor(yaml) {
  const hard = Array.isArray(yaml.hard_stops) ? yaml.hard_stops : [];
  const soft = (Array.isArray(yaml.soft_gaps) ? yaml.soft_gaps : []).join(' ');
  const decision = yaml.final_decision || '';

  if (hard.length > 0) return { outcome: 'FAIL', reason: `hard gate: ${hard.join('; ')}`, hard };
  if (/skip|do not|drop|no amount|disqualif/i.test(decision)) return { outcome: 'FAIL', reason: `final decision: ${decision}`, hard };
  if (soft.length > 0) {
    // A soft gap is screen-relevant when it names an absent skill/keyword.
    const keyworded = /(no |not |never |fewer|absent|lack|hard gate|must have|wants|requires)/i.test(soft);
    return { outcome: keyworded ? 'MARGINAL' : 'PASS', reason: soft.slice(0, 120), hard };
  }
  return { outcome: 'PASS', reason: 'no gates in report', hard };
}

function skillGapHint(jdPath) {
  if (!jdPath || !existsSync(jdPath)) return null;
  try {
    const out = execFileSync('node', [join(__dir, 'jd-skill-gap.mjs'), jdPath, '--json'], { encoding: 'utf8', maxBuffer: (1 << 22) }).trim();
    const parsed = JSON.parse(out);
    if (parsed.lowConfidence) return { lowConfidence: parsed.lowConfidence.reason || 'unparsable JD' };
    return { existing: (parsed.existing || []).length, supported: (parsed.supportedByResume || []).length, gaps: (parsed.gap || []).length };
  } catch { return null; }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  const checks = [
    ['hard_stop → FAIL', verdictFor({ hard_stops: ['no sponsorship'], soft_gaps: [] }).outcome === 'FAIL'],
    ['hard empty + skip decision → FAIL', verdictFor({ hard_stops: [], soft_gaps: [], final_decision: 'Do not apply.' }).outcome === 'FAIL'],
    ['soft missing skill → MARGINAL', verdictFor({ hard_stops: [], soft_gaps: ['no runnable demo published'], final_decision: 'Apply' }).outcome === 'MARGINAL'],
    ['soft framed → PASS', verdictFor({ hard_stops: [], soft_gaps: ['tailor CV to lead with enterprise architecture'], final_decision: 'Apply' }).outcome === 'PASS'],
    ['no gaps → PASS', verdictFor({ hard_stops: [], soft_gaps: [], final_decision: 'Apply' }).outcome === 'PASS'],
  ];
  let n = 0;
  for (const [name, ok] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name}`); if (ok) n++; }
  console.log(`\nscreen-check ${n}/${checks.length} passed`);
  process.exit(n === checks.length ? 0 : 1);
}

// collect tracker open rows
const appsFile = resolveTrackerPath(CAREER_OPS);
const lines = existsSync(appsFile) ? readFileSync(appsFile, 'utf8').split('\n') : [];
let colmap = null;
try { colmap = resolveColumns(lines); } catch {}
const rows = [];
for (const line of lines) {
  if (!colmap || isSeparatorRow(line) || isHeaderRow(line) || !line.trim()) continue;
  const p = line.split('|').map((s) => s.trim());
  const num = parseInt(p[colmap.num], 10);
  if (isNaN(num) || num === 0) continue;
  if ((p[colmap.status] ?? '').trim() !== 'Evaluated') continue; // only open rows
  const rp = resolveReport(num);
  const yaml = rp ? yamlOf(rp) : {};
  const v = verdictFor(yaml);
  const jdPath = rp ? resolveJdPath(rp) : null;
  const jdHint = jdPath ? skillGapHint(jdPath) : null;
  rows.push({ num, company: p[colmap.company] ?? '', role: p[colmap.role] ?? '', score: (p[colmap.score] ?? '').replace('/5', ''), reportPath: rp, outcome: v.outcome, reason: v.reason, hard: v.hard, jdSkillGap: jdHint });
}

const filter = args.indexOf('--row');
const only = filter !== -1 ? parseInt(args[filter + 1], 10) : null;
const viewed = only ? rows.filter((r) => r.num === only) : rows;
if (args.includes('--json')) { console.log(JSON.stringify(viewed, null, 2)); process.exit(0); }
if (only && viewed.length === 0) { console.log(`no open Evaluated row #${only}`); process.exit(2); }
if (viewed.length === 0) { console.log('no open Evaluated rows to check'); process.exit(0); }

console.log('screen-check — estimated resume-screen outcome per open row:');
for (const r of viewed) {
  const icon = r.outcome === 'PASS' ? '✅' : r.outcome === 'MARGINAL' ? '🟡' : '❌';
  console.log(`  ${icon} #${r.num} ${r.company} · ${r.role} · ${r.score}/5 → ${r.outcome}`);
  if (r.reason && r.outcome !== 'PASS') console.log(`        ${r.reason.slice(0, 110)}`);
  if (r.jdSkillGap && (r.jdSkillGap.gaps || 0) > 0) console.log(`        jd-skill-gap: ${r.jdSkillGap.gaps} skill gap(s) in the requirements`);
  else if (r.jdSkillGap && r.jdSkillGap.lowConfidence) console.log(`        jd-skill-gap: not run (${r.jdSkillGap.lowConfidence})`);
}
console.log('\n(Screen outcomes vary by recruiter; hard gates are the dependable blockers.)');
process.exit(0);