// @ts-check
/**
 * concentration.mjs — how concentrated is your pipeline by employer?
 *
 * With best matches often clustered at a handful of companies (Deepgram,
 * Sierra, Supabase), a simple share view surfaces the honest risk: if your
 * top feeder stalls, you're over-exposed. It groups open evaluated rows by
 * company and shows each company's share + the potential-value the eggs-in-
 * one-basket represent.
 *
 * It is read-only and never writes.
 *
 * Usage:
 *   node concentration.mjs                  → per-company share of open rows
 *   node concentration.mjs --row-count 8    → top companies by row share
 *   node concentration.mjs --json
 *   node concentration.mjs --self-test
 */
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { resolveTrackerPath } from './tracker-utils.mjs';
import { resolveColumns, isSeparatorRow, isHeaderRow } from './tracker-parse.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));

function openRows() {
  const apps = resolveTrackerPath(__dir);
  if (!existsSync(apps)) return [];
  const lines = readFileSync(apps, 'utf8').split('\n');
  let colmap = null;
  try { colmap = resolveColumns(lines); } catch { return []; }
  const out = [];
  for (const line of lines) {
    if (!colmap || isSeparatorRow(line) || isHeaderRow(line) || !line.trim()) continue;
    const p = line.split('|').map((s) => s.trim());
    const num = parseInt(p[colmap.num], 10);
    if (isNaN(num) || num === 0) continue;
    if ((p[colmap.status] ?? '').trim() !== 'Evaluated') continue;
    out.push({ num, company: p[colmap.company] ?? '', role: p[colmap.role] ?? '', score: parseFloat((p[colmap.score] ?? '').replace('/5', '')) || 0 });
  }
  return out;
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  const sample = [
    { num: 1, company: 'Deepgram', role: 'a', score: 4.4 },
    { num: 2, company: 'Deepgram', role: 'b', score: 3.5 },
    { num: 3, company: 'Sierra', role: 'c', score: 3.9 },
    { num: 4, company: 'Sierra', role: 'd', score: 3.8 },
  ];
  const byCompany = groupByCompany(sample);
  const checks = [
    ['groups by company', byCompany['Deepgram'].count === 2 && byCompany['Sierra'].count === 2],
    ['share computes', byCompany['Deepgram'].share === 50],
    ['top company picks max', topCompany(byCompany) === 'Deepgram'],
  ];
  let n = 0;
  for (const [name, ok] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name}`); if (ok) n++; }
  console.log(`\nconcentration ${n}/${checks.length} passed`);
  process.exit(n === checks.length ? 0 : 1);
}

function groupByCompany(rows) {
  const map = {};
  for (const r of rows) { map[r.company] ||= { count: 0, scoreSum: 0 }; map[r.company].count++; map[r.company].scoreSum += r.score; }
  const total = rows.length;
  for (const k of Object.keys(map)) map[k].share = Math.round((map[k].count / total) * 100);
  return map;
}
function topCompany(byCompany) {
  const es = Object.entries(byCompany).sort((a, b) => b[1].count - a[1].count);
  return es[0] ? es[0][0] : null;
}

const rows = openRows();
const byCompany = groupByCompany(rows);
const uniq = Object.keys(byCompany).length;
const topPair = Object.entries(byCompany).sort((a, b) => b[1].count - a[1].count)[0];

if (args.includes('--json')) { console.log(JSON.stringify(byCompany, null, 2)); process.exit(0); }
if (uniq === 0) { console.log('no open evaluated rows to concentration-check'); process.exit(0); }

// --row-count N: top N companies by row share (e.g. just the biggest holders)
const rcIdx = args.indexOf('--row-count');
if (rcIdx !== -1) {
  const n = parseInt(args[rcIdx + 1], 10);
  const k = Number.isInteger(n) && n > 0 ? n : 6;
  const ranked = Object.entries(byCompany).sort((a, b) => b[1].count - a[1].count).slice(0, k);
  console.log(`concentration — top ${k} employer(s) by open-row share (of ${rows.length} rows)`);
  for (const [name, g] of ranked) console.log(`  · ${name.padEnd(14)} ${g.count} row(s)  ${g.share}%`);
  process.exit(0);
}

console.log('concentration — how much of your pipeline rests on one employer?');
console.log(`  ${rows.length} open rows across ${uniq} companies`);
for (const [name, g] of Object.entries(byCompany).sort((a, b) => b[1].count - a[1].count).slice(0, 6)) {
  console.log(`  · ${name.padEnd(14)} ${g.count} row(s)  ${g.share}% of pipeline`);
}
const maroon = (topPair && topPair[1].share >= 40) ? '⚠ ' : '';
console.log(`\n  ${maroon}Largest exposure: ${topPair ? topPair[0] : '—'} at ${topPair ? topPair[1].share : 0}%` + (topPair && topPair[1].share >= 40 ? ' — high single-employer concentration' : ''));
process.exit(0);