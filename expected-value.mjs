// @ts-check
/**
 * expected-value.mjs — which blocked PREP row is worth your next hour?
 *
 * launchpad says "PREP first" but not *which* prep is worth the hour. This
 * scores each open evaluated row by expected value:
 *
 *   EV  ≈  (probability the prep clears the blocker) × (fit score) × (comp)
 *
 * using only data already in your files (never fabricated figures):
 *   score   — the evaluation score from the report
 *   comp    — advertised_comp from the report (parsed band lower bound), or a
 *             neutral default when absent
 *   clearIn — a coarse ordinal probability from the blocker type: fixable
 *             (portfolio/comp) is easier to clear than structural (relocation).
 *
 * Read-only; a decision aid, not a guarantee.
 *
 * Usage:
 *   node expected-value.mjs                     → EV-ranked open rows
 *   node expected-value.mjs --row 8             → one row detail
 *   node expected-value.mjs --json
 *   node expected-value.mjs --self-test
 */
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { resolveTrackerPath } from './tracker-utils.mjs';
import { resolveColumns, isSeparatorRow, isHeaderRow, extractTrackerReportNumbers } from './tracker-parse.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = getCareerOpsRoot();

function yamlOf(p) {
  try {
    const t = readFileSync(p, 'utf8');
    const fence = t.match(/```yaml[^\n]*\n([\s\S]*?)\n```/);
    if (!fence) return {};
    const out = {}; let listKey = null;
    for (const raw of fence[1].split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (/^\s{2,}\w+:/.test(line) || !line.trim()) { listKey = null; continue; }
      const kv = line.match(/^(\w+):\s*(.*)$/); if (kv) { out[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2'); listKey = kv[1]; continue; }
      const item = line.match(/^\s*-\s+(.*)$/); if (item) { out[listKey] = out[listKey] || []; out[listKey].push(item[1].trim().replace(/^(["'])(.*)\1$/, '$2')); continue; }
      listKey = null;
    }
    return out;
  } catch { return {}; }
}
function resolveReport(num) {
  const base = join(CAREER_OPS, 'reports');
  if (!existsSync(base)) return null;
  try { const hit = readdirSync(base).find((f) => new RegExp(`^0*${num}-[^/]+\\.md$`, 'i').test(f)); return hit ? join(base, hit) : null; } catch { return null; }
}
function parseCompBand(s) {
  if (!s) return null;
  // The naive `\d+` extraction used to treat "35.000" (Spain/Germany/Italy:
  // period = thousands) as 35 — below the n>=10000 floor, so the comp was
  // silently dropped and the row ranked with a neutral default. Mirror
  // salary-gap.mjs's separator canonicalization (#3174): when both separators
  // appear the LAST one is decimal, a lone separator is grouping iff exactly
  // three digits follow it, and only then is it removed. Unchanged behaviour
  // `k`-suffixed values are matched WITH their suffix and multiplied by 1000
  // below — never stripped first (the original parser's contract).
  const cleaned = String(s).replace(/[$€£\u20AC]/g, '');
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let numStr = cleaned;
  if (lastComma !== -1 && lastDot !== -1) {
    const decimal = lastComma > lastDot ? ',' : '.';
    const grouping = decimal === ',' ? '.' : ',';
    numStr = cleaned.split(grouping).join('').replace(decimal, '.');
  } else {
    const sep = lastComma !== -1 ? ',' : lastDot !== -1 ? '.' : null;
    if (sep !== null) {
      const grouped = new RegExp(`(\\d)\\${sep}(?=\\d{3}(?!\\d))`, 'g');
      numStr = cleaned.replace(grouped, '$1').replace(sep, '.');
    }
  }
  const nums = (numStr.match(/\d+(?:\.\d+)?\s*[kK]?/g) || []).map((t) => {
    const x = t.trim();
    return /k$/i.test(x) ? parseFloat(x) * 1000 : parseFloat(x);
  }).filter((n) => Number.isFinite(n) && n >= 10000);
  return nums.length ? (nums.reduce((a, b) => a + b, 0) / nums.length) : null;
}

// blocker-clearing ease: fixable → 0.85 prob, structural → 0.2, none → 1.0
function clearProb(blocker) {
  if (blocker === 'fixable') return 0.85;
  if (blocker === 'structural') return 0.2;
  return 1.0; // no blocker to clear
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  const checks = [
    ['fixable prob high', clearProb('fixable') === 0.85],
    ['structural prob low', clearProb('structural') === 0.2],
    ['no blocker → 1', clearProb(null) === 1],
    ['parse comp band', parseCompBand('$150,000-$200,000') === 175000],
    ['no band → null', parseCompBand('') === null],
    ['plain range', parseCompBand('80k-90k') === 85000],
    ['period-grouped', parseCompBand('€35.000 - €45.000') === 40000],
    ['comma decimal', parseCompBand('€45.000,00') === 45000],
    ['us decimal', parseCompBand('$123,684.50') === 123684.5],
  ];
  let n = 0;
  for (const [name, ok] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name}`); if (ok) n++; }
  console.log(`\nexpected-value ${n}/${checks.length} passed`);
  process.exit(n === checks.length ? 0 : 1);
}

// gather
const appsFile = resolveTrackerPath(CAREER_OPS);
const lines = existsSync(appsFile) ? readFileSync(appsFile, 'utf8').split('\n') : [];
let colmap = null; try { colmap = resolveColumns(lines); } catch {}
const evs = [];
for (const line of lines) {
  if (!colmap || isSeparatorRow(line) || isHeaderRow(line) || !line.trim()) continue;
  const p = line.split('|').map((s) => s.trim());
  const num = parseInt(p[colmap.num], 10);
  if (isNaN(num) || num === 0) continue;
  if ((p[colmap.status] ?? '').trim() !== 'Evaluated') continue;
  const score = parseFloat((p[colmap.score] ?? '').replace('/5', '')) || 0;
  const reportNum = (extractTrackerReportNumbers(p[colmap.report] ?? '', p[colmap.notes] ?? '')[0]) ?? num;
  const rp = resolveReport(reportNum);
  const yaml = rp ? yamlOf(rp) : {};
  const softAll = (Array.isArray(yaml.soft_gaps) ? yaml.soft_gaps : []).join(' ');
  const isFixture = /test fixture|synthetic|calibrat/i.test(`${p[colmap.role] ?? ''} ${p[colmap.notes] ?? ''}`);
  if (isFixture) continue;
  // Structural when a hard stop exists OR the soft gaps name a relocation /
  // visa / language / in-person gate (matches launchpad's classifier).
  const structuralRe = /relocat|in-person|on-site|onsite|visa|sponsorship|fluent|fluency|san francisco|new york|relocation|in-office|campus/i;
  const blocker = (Array.isArray(yaml.hard_stops) && yaml.hard_stops.length) ? 'structural'
    : structuralRe.test(softAll) ? 'structural'
      : (Array.isArray(yaml.soft_gaps) && yaml.soft_gaps.length) ? 'fixable' : null;
  const comp = parseCompBand(yaml.advertised_comp);
  const prob = clearProb(blocker);
  const compFactor = comp ? Math.pow(comp / 100000, 0.5) : 1; // sqrt scale so comp doesn't dominate
  const ev = Math.round(prob * score * compFactor * 100) / 100;
  evs.push({ num, company: p[colmap.company] ?? '', role: p[colmap.role] ?? '', score, blocker, prob, comp: comp ?? null, ev });
}
evs.sort((a, b) => b.ev - a.ev);

const rowF = args.indexOf('--row');
const only = rowF !== -1 ? parseInt(args[rowF + 1], 10) : null;
const viewed = only ? evs.filter((r) => r.num === only) : evs;
if (args.includes('--json')) { console.log(JSON.stringify(viewed.slice(0, only ? viewed.length : 15), null, 2)); process.exit(0); }
if (viewed.length === 0) { console.log('no open Evaluated rows'); process.exit(0); }

console.log('expected-value — highest EV prep/work order (higher is better):');
for (const e of viewed.slice(0, 12)) {
  console.log(`  ${e.ev.toFixed(2)}  #${e.num} ${e.company} · ${e.role}  (${e.score}/5, ${e.blocker || 'ready'}, comp ${e.comp ? '$' + Math.round(e.comp) : 'n/a'})`);
}
console.log('\nEV = P(clear blocker) × score × comp-factor. Advisory — your call on which prep to do.');
process.exit(0);