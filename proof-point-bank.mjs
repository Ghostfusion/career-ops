// @ts-check
/**
 * proof-point-bank.mjs — track your unpublished→published project artifacts as
 * an asset that unblocks launchpad rows.
 *
 * Every strong match in this checkout was gated by the same report phrase:
 * "apply with a runnable eval demo", "send us the GitHub", "publish the
 * artifacts". career-ops has no home for these artifacts as a tracked asset.
 * This script manages a small append-only ledger (data/proof-points.tsv) and
 * reports which launchpad rows each project, once published, would clear.
 *
 * It NEVER touches the tracker. Blockers are inferred by keyword-overlap with
 * launchpad rows' `next_action`/`soft_gaps`; clearing them is a launchpad
 * concern (the mode reclassifies when the user marks a project published).
 *
 * Usage:
 *   node proof-point-bank.mjs --list                 → ledger rows
 *   node proof-point-bank.mjs --list json           → JSON rows
 *   node proof-point-bank.mjs --unblocks            → which launchpad rows each proof clears
 *   node proof-point-bank.mjs --add <name> --status building --blocks "eval harness"
 *   node proof-point-bank.mjs --set <name> published --url https://github.com/...
 *   node proof-point-bank.mjs --self-test
 *
 * Exit codes: 0 ok · 1 usage · 2 not-found · 4 write failure.
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, renameSync } from 'fs';
import { resolveTrackerPath } from './tracker-utils.mjs';
import { resolveColumns, isSeparatorRow, isHeaderRow, extractTrackerReportNumbers } from './tracker-parse.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ledgerPath = join(__dir, 'data', 'proof-points.tsv');
const HEADER = `name\tstatus\turl\tblocks\tupdated\n`;
const STATUSES = ['idea', 'building', 'published'];

// ── ledger IO ────────────────────────────────────────────────────────────────
function readLedger() {
  if (!existsSync(ledgerPath)) return [];
  const lines = readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === 0 && lines[i].startsWith('name\t')) continue; // header
    const p = lines[i].split('\t');
    out.push({ name: p[0] ?? '', status: p[1] ?? '', url: p[2] ?? '', blocks: (p[3] ?? '').split('|').filter(Boolean), updated: p[4] ?? '' });
  }
  return out;
}
function writeLedger(rows) {
  try {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    const lines = [HEADER];
    for (const r of rows) lines.push([r.name, r.status, r.url, r.blocks.join('|'), r.updated].join('\t'));
    const tmp = `${ledgerPath}.tmp${process.pid}`;
    writeFileSync(tmp, lines.join('\n') + '\n');
    renameSync(tmp, ledgerPath);
    return true;
  } catch { return false; }
}
function now() { return new Date().toISOString().slice(0, 10); }

// ── report YAML + launchpad-row reading ──────────────────────────────────────
function resolveReportPath(num) {
  const base = join(__dir, 'reports');
  if (!existsSync(base)) return null;
  try {
    const hit = readdirSync(base).find((f) => new RegExp(`^0*${num}-[^/]+\\.md$`, 'i').test(f));
    return hit ? join(base, hit) : null;
  } catch { return null; }
}
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

function openLaunchpadRows() {
  const appsFile = resolveTrackerPath(__dir);
  if (!existsSync(appsFile)) return [];
  const lines = readFileSync(appsFile, 'utf8').split('\n');
  const colmap = resolveColumns(lines);
  const rows = [];
  for (const line of lines) {
    if (isSeparatorRow(line) || isHeaderRow(line) || !line.trim()) continue;
    const parts = line.split('|').map((s) => s.trim());
    const num = parseInt(parts[colmap.num], 10);
    if (isNaN(num) || num === 0) continue;
    if ((parts[colmap.status] ?? '').trim() !== 'Evaluated') continue;
    const reportNum = (extractTrackerReportNumbers(parts[colmap.report] ?? '', parts[colmap.notes] ?? '')[0]) ?? num;
    const rp = resolveReportPath(reportNum);
    const yaml = rp ? readReportYaml(rp) : {};
    const scoreRaw = parts[colmap.score] ?? '';
    const score = scoreRaw.endsWith('/5') ? parseFloat(scoreRaw.replace(/\/5$/, '')) : null;
    rows.push({ num, company: parts[colmap.company] ?? '', role: parts[colmap.role] ?? '', score, nextAction: yaml.next_action ?? '', softGaps: (Array.isArray(yaml.soft_gaps) ? yaml.soft_gaps : []).join(' ') });
  }
  return rows.filter((r) => !/test fixture|synthetic|calibrat/i.test(`${r.role} ${r.nextAction}`));
}

function rowUnblockedBy(row, proof) {
  const needles = (proof.blocks || []).map((b) => String(b).toLowerCase()).filter(Boolean);
  if (needles.length === 0) return false;
  const hay = `${row.nextAction} ${row.softGaps} ${row.role}`.toLowerCase();
  return needles.some((n) => hay.includes(n));
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  const checks = [
    ['matches block token', rowUnblockedBy({ nextAction: 'apply with a runnable eval harness', softGaps: '', role: '' }, { blocks: ['eval harness'] }) === true],
    ['no token → not unblocked', rowUnblockedBy({ nextAction: 'verify comp on first call', softGaps: '', role: '' }, { blocks: ['demo'] }) === false],
    ['empty blocks → false', rowUnblockedBy({ nextAction: 'anything', softGaps: '', role: '' }, { blocks: [] }) === false],
  ];
  let n = 0;
  for (const [name, ok] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name}`); if (ok) n++; }
  console.log(`\nproof-point-bank self-test: ${n}/${checks.length} passed`);
  process.exit(n === checks.length ? 0 : 1);
}

let rows = readLedger();

if (args.includes('--list')) {
  const asJson = args[args.indexOf('--list') + 1] === 'json';
  if (asJson) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
  if (rows.length === 0) { console.log('proof-point ledger is empty — add one with --add'); process.exit(0); }
  console.log('proof-points (status · name · url · blocks):');
  for (const r of rows) console.log(`  [${r.status}] ${r.name}${r.url ? `  ${r.url}` : ''}${r.blocks.length ? `  → unblocks: ${r.blocks.join(', ')}` : ''}`);
  process.exit(0);
}

if (args.includes('--unblocks')) {
  const open = openLaunchpadRows()
    // Only surface rows worth unblocking — score ≥ 3.5 (ACT/PREP/HOLD tier).
    // A 2.x SKIP row isn't revived by publishing a demo, so it would just
    // add noise.
    .filter((r) => r.score != null && r.score >= 3.5);
  console.log('proof-point → launchpad rows (≥3.5) it would unblock:');
  for (const p of rows) {
    const hit = (p.status === 'published') ? open.filter((r) => rowUnblockedBy(r, p)) : [];
    if (hit.length === 0) { console.log(`  [${p.status}] ${p.name}${p.status === 'published' ? ' — no open evaluated row currently references its topic' : ' — not yet published; no launchpad impact'}`); continue; }
    console.log(`  [published] ${p.name} → unblocks ${hit.length} launchpad row(s):`);
    for (const r of hit) console.log(`      #${r.num} ${r.company} · ${r.role}  → ${r.nextAction.slice(0, 90)}${r.nextAction.length > 90 ? '…' : ''}`);
  }
  process.exit(0);
}

const ai = args.indexOf('--add');
if (ai !== -1) {
  let name = args[ai + 1];
  while (name && name.startsWith('--')) name = args[++ai + 1];
  if (!name || name.startsWith('--')) { console.error('Usage: --add <name> [--status idea|building|published] [--url …] [--blocks "a|b"]'); process.exit(2); }
  const status = (args.indexOf('--status') !== -1 ? (args[args.indexOf('--status') + 1] || '') : 'building') || 'building';
  const url = args.indexOf('--url') !== -1 ? (args[args.indexOf('--url') + 1] || '') : '';
  const rawBlocks = args.indexOf('--blocks') !== -1 ? (args[args.indexOf('--blocks') + 1] || '') : '';
  const blocks = rawBlocks.split('|').map((s) => s.trim()).filter(Boolean);
  if (!STATUSES.includes(status)) { console.error(`invalid status "${status}" — use idea|building|published`); process.exit(1); }
  rows.push({ name, status, url, blocks, updated: now() });
  if (writeLedger(rows)) { console.log(`added ─ "${name}" [${status}]`); process.exit(0); }
  console.error('write failed'); process.exit(4);
}

const si = args.indexOf('--set');
if (si !== -1) {
  const name = args[si + 1]; const status = args[si + 2];
  if (!name || !status) { console.error('usage: --set <name> <status>'); process.exit(2); }
  const url = args.indexOf('--url') !== -1 ? (args[args.indexOf('--url') + 1] ?? '') : '';
  const row = rows.find((r) => r.name.toLowerCase() === name.toLowerCase());
  if (!row) { console.error(`no proof-point named "${name}"`); process.exit(2); }
  row.status = STATUSES.includes(status) ? status : row.status;
  if (url) row.url = url;
  row.updated = now();
  if (writeLedger(rows)) { console.log(`updated "${name}" → [${row.status}]${row.url ? ` ${row.url}` : ''}`); process.exit(0); }
  console.error('write failed'); process.exit(4);
}

// default: list
if (rows.length === 0) { console.log('proof-point ledger is empty — add a project with --add'); process.exit(0); }
console.log('proof-point ledger:');
for (const r of rows) console.log(`  [${r.status}] ${r.name}${r.url ? `  ${r.url}` : ''}${r.blocks.length ? `  → ${r.blocks.join(', ')}` : ''}`);
process.exit(0);