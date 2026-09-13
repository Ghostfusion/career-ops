// @ts-check
/**
 * salary-trend.mjs — track the advertised comp band for a role family over
 * time, to see whether your target band is realistically available in the
 * roles you're competing at — before wasting effort on short-paying ones.
 *
 * Reads every evaluation report's Machine Summary `advertised_comp` (a small
 * YAML fence) and groups by role-family (fuzzy-normalized, company-agnostic),
 * then prints the observed band span + how many advertised bands overlap your
 * profile.yml target_range.
 *
 * Usage:
 *   node salary-trend.mjs                        → per-family bands
 *   node salary-trend.mjs --json                 → JSON
 *   node salary-trend.mjs --family swe-ai        → filter one family
 *   node salary-trend.mjs --self-test
 *
 * Read-only — never writes.
 */
import { join } from 'path';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { getCareerOpsRoot } from './path-resolver.mjs';
// The one amount parser for this field — see parseComp below.
import { parseAmount } from './salary-gap.mjs';

const CAREER_OPS = getCareerOpsRoot();

// ── report YAML read ─────────────────────────────────────────────────────────
function readReportYaml(p) {
  try {
    const t = readFileSync(p, 'utf8');
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

// natural "$150,000-$200,000" / "$120,000" / "$120k-$140k" / "80-90k EUR"
// → [min,max] USD-or-not (no FX conversion; the tool only groups and spans)
//
// `advertised_comp` is the same field salary-gap.mjs parses (as an observation's
// `amount`), so it has to be parsed the same way. A local strip-separators-then-
// parse loop got the k-suffix and decimals wrong in opposite directions:
// "80-90k EUR" → [90000,90000] (the un-suffixed 80 fell under its >=5000 noise
// filter) and "82.5k" → 825000, "$123,684.50" → 12368450 — so two readers of one
// field disagreed and every span/median/overlap count here was off. parseAmount
// returns {min,max,mid}; map that onto the [min,max] shape used below.
function parseComp(raw) {
  const amt = parseAmount(raw);
  return amt ? [amt.min, amt.max] : null;
}

// role-family key (company-agnostic so it spans roles)
function roleFamily(role) {
  const r = (role || '').toLowerCase();
  if (/\b(software engineer|swe|engineer)\b/.test(r)) return 'swe-ai';
  if (/\b(product manager|product marketing|pm)\b/.test(r)) return 'pm';
  if (/\barchitect\b/.test(r)) return 'architect';
  if (/\b(solutions engineer|forward.?deployed|field engineer|resident)\b/.test(r)) return 'solutions';
  if (/\b(strategist|enablement|adoption)\b/.test(r)) return 'strategist';
  if (/\b(engineering manager|em)\b/.test(r)) return 'em';
  if (/\b(platform|infrastructure|mlops)\b/.test(r)) return 'infra';
  return 'other';
}

function targetBand() {
  try {
    const t = readFileSync(join(CAREER_OPS, 'config', 'profile.yml'), 'utf8');
    const m = t.match(/target_range:\s*["']?([^"'\n]+)/);
    return m ? parseComp(m[1]) : null;
  } catch { return null; }
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  const checks = [
    ['band', JSON.stringify(parseComp('$150,000-$200,000')) === '[150000,200000]'],
    ['single', JSON.stringify(parseComp('$120,000')) === '[120000,120000]'],
    ['k', JSON.stringify(parseComp('$120k-$140k')) === '[120000,140000]'],
    // The schema's own documented shape: one k suffix covers BOTH bounds.
    ['k range with currency suffix', JSON.stringify(parseComp('80-90k EUR')) === '[80000,90000]'],
    ['decimal k', JSON.stringify(parseComp('82.5k')) === '[82500,82500]'],
    ['cents', JSON.stringify(parseComp('$123,684.50')) === '[123684.5,123684.5]'],
    ['none', parseComp('competitive') === null],
    ['family swe', roleFamily('Senior Software Engineer, Applied AI (Senior or Staff)') === 'swe-ai'],
    ['family pm', roleFamily('Staff Product Manager, Agentic Experiences') === 'pm'],
  ];
  let n = 0;
  for (const [name, ok] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name}`); if (ok) n++; }
  console.log(`\nsalary-trend self-test: ${n}/${checks.length} passed`);
  process.exit(n === checks.length ? 0 : 1);
}

// ── gather ───────────────────────────────────────────────────────────────────
const base = join(CAREER_OPS, 'reports');
const famMap = {};
if (existsSync(base)) {
  for (const file of readdirSync(base)) {
    if (!/^\d{3}-.+\.md$/.test(file)) continue;
    const yaml = readReportYaml(join(base, file));
    if (!yaml.role || !yaml.advertised_comp) continue;
    const band = parseComp(yaml.advertised_comp);
    if (!band) continue;
    const fam = roleFamily(yaml.role);
    famMap[fam] = famMap[fam] || { family: fam, bands: [], latest: yaml.advertised_comp };
    famMap[fam].bands.push(band);
    famMap[fam].latest = yaml.advertised_comp;
  }
}
const fams = Object.values(famMap)
  .map((f) => {
    const mins = f.bands.map((b) => b[0]); const maxs = f.bands.map((b) => b[1]);
    const sorted = f.bands.map((b) => (b[0] + b[1]) / 2).sort((a, b) => a - b);
    f.min = Math.min(...mins); f.max = Math.max(...maxs);
    f.medianBand = sorted[(sorted.length - 1) >> 1];
    f.count = f.bands.length;
    return f;
  })
  .sort((a, b) => b.count - a.count);

const target = targetBand();
if (args.includes('--json')) { console.log(JSON.stringify({ target, families: fams }, null, 2)); process.exit(0); }

const flt = args[args.indexOf('--family') + 1];
const shown = flt ? fams.filter((f) => f.family === flt) : fams;
if (shown.length === 0) { console.log(`no advertised comp data for ${flt ? `family "${flt}"` : 'any family'} in reports yet`); process.exit(0); }

console.log('salary-trend — advertised comp bands by role family');
console.log(`  target: ${target ? `$${target[0].toLocaleString('en-US')}–$${target[1].toLocaleString('en-US')}` : '(not set in profile.yml)'}`);
for (const f of shown) {
  console.log(`  ${f.family} (${f.count} report${f.count === 1 ? '' : 's'})  latest: ${f.latest}`);
  console.log(`     observed span: $${f.min.toLocaleString('en-US')} – $${f.max.toLocaleString('en-US')}   median: $${f.medianBand.toLocaleString('en-US')}`);
  if (target) {
    const hits = f.bands.filter((b) => b[1] >= target[0] && b[0] <= target[1]);
    console.log(`     ${hits.length}/${f.count} advertised bands overlap your target`);
  }
}
process.exit(0);