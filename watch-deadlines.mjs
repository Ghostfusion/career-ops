// @ts-check
/**
 * watch-deadlines.mjs — flag reply-by / offer-expiry / interview-window dates
 * from the tracker and follow-ups, surfaced at session start.
 *
 * This is deadline-native, distinct from followup-cadence which is wait-based:
 * it reads explicit date markers in tracker Notes and follow-ups table rows and
 * reports anything inside a lookahead window (default 7 days) or already past.
 *
 * Date markers recognized in Notes (case-insensitive substring match):
 *   respond-by YYYY-MM-DD    recruiter reply deadline
 *   reply-by  YYYY-MM-DD    alias
 *   expires   YYYY-MM-DD    offer expiry
 *   window    YYYY-MM-DD    interview/offer window
 *   by        YYYY-MM-DD    generic deadline
 *   due       YYYY-MM-DD    generic deadline
 *
 * Usage:
 *   node watch-deadlines.mjs --lookahead 7     → report deadlines in next 7d
 *   node watch-deadlines.mjs --json           → machine-readable
 *   node watch-deadlines.mjs --self-test      → built-in test harness
 *
 * Exit codes: 0 ok (incl. no deadlines) · 1 usage/parse · 2 write failure.
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { resolveTrackerPath } from './tracker-utils.mjs';
import { resolveColumns, isSeparatorRow, isHeaderRow, parseTrackerRow } from './tracker-parse.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const DAY_MS = 86400000;
const MARKER_RE = /\b(respond[- ]?by|reply[- ]?by|offer[- ]?(?:exp(?:iry|ires)?)?|window|by|due)\s+(\d{4}-\d{2}-\d{2})\b/i;

function todayUTC() { const n = new Date(); return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()); }
function msOf(y, m, d) { return Date.UTC(y, m - 1, d); }
function parseDate(str) {
  const m = String(str).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return NaN;
  const ms = msOf(+m[1], +m[2], +m[3]);
  // Date.UTC silently rolls over (2026-02-30 → Mar 2). Reject any string
  // that doesn't round-trip unchanged, mirroring followup-seed's
  // isValidCalendarDate.
  return iso(ms) === String(str) ? ms : NaN;
}
function iso(ms) { return new Date(ms).toISOString().slice(0, 10); }

// ── tracker deadline scan (Applied / Responded / Interview / Offer only) ─────
function scanTrackerDeadlines() {
  const appsFile = resolveTrackerPath(__dir);
  if (!existsSync(appsFile)) return [];
  const lines = readFileSync(appsFile, 'utf8').split('\n');
  const colmap = resolveColumns(lines);
  const out = [];
  for (const line of lines) {
    if (isSeparatorRow(line) || isHeaderRow(line) || !line.trim()) continue;
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;
    const status = String(row.status).trim();
    if (!['Applied', 'Responded', 'Interview', 'Offer'].includes(status)) continue;
    const hay = `${row.notes} ${row.report}`;
    const m = hay.match(MARKER_RE);
    if (!m) continue;
    const dateMs = parseDate(m[2]);
    if (isNaN(dateMs)) continue;
    out.push({ num: row.num, company: row.company, role: row.role, status, label: m[1].toLowerCase(), date: iso(dateMs), dateMs });
  }
  return out;
}

// ── follow-ups table rows (next follow-up dates) ─────────────────────────────
function scanFollowupDates() {
  const fp = join(__dir, 'data', 'follow-ups.md');
  if (!existsSync(fp)) return [];
  const lines = readFileSync(fp, 'utf8').split('\n');
  const out = [];
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const p = line.split('|').map((s) => s.trim());
    const num = parseInt(p[1], 10);
    const date = p[3];
    if (isNaN(num) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const dateMs = parseDate(date);
    if (isNaN(dateMs)) continue;
    out.push({ num, company: p[4] ?? '', role: p[5] ?? '', status: 'Follow-up', label: 'follow-up', date, dateMs });
  }
  return out;
}

function compute(today, lookaheadDays) {
  const all = [...scanTrackerDeadlines(), ...scanFollowupDates()];
  return all
    .map((d) => ({ ...d, daysOut: Math.round((d.dateMs - today) / DAY_MS) }))
    .filter((d) => !isNaN(d.daysOut))
    .sort((a, b) => a.daysOut - b.daysOut);
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  const nowMs = msOf(2026, 8, 22);
  const checks = [
    ['parseDate ok', parseDate('2026-08-22') === nowMs],
    ['parseDate invalid', isNaN(parseDate('2026-02-30'))],
    ['days future', Math.round((parseDate('2026-08-25') - nowMs) / DAY_MS) === 3],
    ['days past', Math.round((parseDate('2026-08-20') - nowMs) / DAY_MS) === -2],
  ];
  let n = 0;
  for (const [name, ok] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name}`); if (ok) n++; }
  console.log(`\nwatch-deadlines self-test: ${n}/${checks.length} passed`);
  process.exit(n === checks.length ? 0 : 1);
}

const lookahead = parseInt((args[args.indexOf('--lookahead') + 1]) || '7', 10) || 7;
const today = todayUTC();
const rows = compute(today, lookahead);

if (args.includes('--json')) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
const urgent = rows.filter((r) => r.daysOut <= lookahead && r.dateMs >= today - DAY_MS * 30); // flag upcoming + recent-past
if (urgent.length === 0) { console.log(`✓ no deadlines within ${lookahead}d`); process.exit(0); }
console.log(`⏰ ${urgent.length} deadline(s) to watch:`);
for (const r of urgent) {
  const when = r.daysOut < 0 ? `overdue ${-r.daysOut}d` : r.daysOut === 0 ? 'TODAY' : `in ${r.daysOut}d`;
  console.log(`   #${r.num} ${r.company} · ${r.role} [${r.status}]  ${r.label} ${r.date}  (${when})`);
}
process.exit(0);