// tests/negotiate.test.mjs — negotiate.mjs builds one negotiation briefing for
// a single tracker row by coordinating salary-trend / negotiation-roi /
// salary-gap. It exported nothing and had no test.
//
// What is asserted here is negotiate's own contract, not the children's:
//
//   --json      the documented structured payload ({ row, market, roiSummary,
//               gap }) and the row it resolves out of the tracker.
//   --row <n>   the human briefing names that row; an unknown row is null, not
//               a crash (the script has no not-found exit path).
//   roiSummary  stays empty when there is no cv.md — the anti-fabrication gate
//               is that claims are used only when they appear verbatim in it.
//
// Every run happens in a child with the data root and the cwd pointed at
// DIFFERENT temp directories; the fixture data root never contains a cv.md, so
// the checkout's own cv.md can never leak in.
//
// Run:  node --test tests/negotiate.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const TRACKER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|---|---|---|---|---|---|---|---|',
  '| 1 | 2026-01-05 | Acme | Backend Engineer | 4.2/5 | Applied | ✅ | | n |',
  '| 2 | 2026-02-05 | Globex | ML Engineer | 4.4/5 | Interview | ✅ | | n |',
  '',
].join('\n');

function fixture({ tracker = true } = {}) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-negotiate-'));
  const decoyCwd = mkdtempSync(join(tmpdir(), 'career-ops-negotiate-cwd-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  if (tracker) writeFileSync(join(dataRoot, 'data', 'applications.md'), TRACKER);
  return { dataRoot, decoyCwd };
}

function run(args, { dataRoot, decoyCwd }) {
  const r = spawnSync(process.execPath, [join(ROOT, 'negotiate.mjs'), ...args], {
    cwd: decoyCwd,
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, CAREER_OPS_ROOT: dataRoot, CAREER_OPS_DATA_DIR: '' },
  });
  assert.equal(r.error, undefined, `spawn failed: ${r.error?.message}`);
  return { ...r, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const cleanup = (f) => {
  for (const d of [f.dataRoot, f.decoyCwd]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
};

test('--self-test verifies the parts resolve', () => {
  const f = fixture();
  try {
    const r = run(['--self-test'], f);
    assert.equal(r.status, 0, `self-test failed:\n${r.all.slice(0, 400)}`);
    assert.match(r.stdout, /negotiate 2\/2 passed/, `unexpected self-test verdict:\n${r.all.slice(0, 400)}`);
  } finally { cleanup(f); }
});

test('--row <n> --json returns the documented payload for that tracker row', () => {
  const f = fixture();
  try {
    const r = run(['--row', '2', '--json'], f);
    assert.equal(r.status, 0, `exited ${r.status}:\n${r.all.slice(0, 400)}`);
    const p = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(p).sort(), ['gap', 'market', 'roiSummary', 'row'], `payload shape changed:\n${r.stdout.slice(0, 300)}`);
    assert.deepEqual(p.row, { company: 'Globex', role: 'ML Engineer', status: 'Interview' }, 'the row must be read from the tracker');
    assert.ok(Array.isArray(p.market?.families), `market is salary-trend --json:\n${r.stdout.slice(0, 300)}`);
    assert.equal(typeof p.roiSummary, 'string');
    assert.equal(typeof p.gap, 'string');
    assert.match(p.gap, /"num":\s*"2"/, 'the comp gap must be computed for the requested row');
  } finally { cleanup(f); }
});

test('an unknown row is reported as null rather than crashing', () => {
  const f = fixture();
  try {
    const r = run(['--row', '99', '--json'], f);
    assert.equal(r.status, 0, `exited ${r.status}:\n${r.all.slice(0, 400)}`);
    assert.equal(JSON.parse(r.stdout).row, null, 'row #99 is not in the tracker');
  } finally { cleanup(f); }
});

test('the human briefing names the row and keeps the verbatim-claim caveat', () => {
  const f = fixture();
  try {
    const r = run(['--row', '2'], f);
    assert.equal(r.status, 0, `exited ${r.status}:\n${r.all.slice(0, 400)}`);
    assert.match(r.stdout, /Negotiation briefing — Globex · ML Engineer/, `wrong briefing header:\n${r.all.slice(0, 400)}`);
    assert.match(r.stdout, /quote only claims that appear verbatim in cv\.md/, 'the briefing must carry the anti-fabrication note');
    assert.match(r.stdout, /Comp gap:/, 'the briefing must include the comp gap section');
  } finally { cleanup(f); }
});

test('without a cv.md nothing is claimed as verified', () => {
  // negotiation-roi's gate: a story-bank figure is used only if the same
  // number appears verbatim in cv.md. The fixture has no cv.md, so the gate
  // must exclude everything rather than leak the checkout's cv.md.
  const f = fixture();
  try {
    const r = run(['--row', '2', '--json'], f);
    const p = JSON.parse(r.stdout);
    assert.equal(p.roiSummary, '', `a data root without cv.md verified claims:\n${p.roiSummary.slice(0, 300)}`);
    const human = run(['--row', '2'], f);
    assert.match(human.stdout, /no quantified claims yet/, `the briefing must say so instead of inventing ROI:\n${human.all.slice(0, 400)}`);
  } finally { cleanup(f); }
});

test('it is read-only: the tracker and the launch directory are untouched', () => {
  const f = fixture();
  try {
    const before = readFileSync(join(f.dataRoot, 'data', 'applications.md'), 'utf-8');
    const r = run(['--row', '2', '--json'], f);
    assert.equal(r.status, 0, `exited ${r.status}:\n${r.all.slice(0, 400)}`);
    assert.equal(
      readFileSync(join(f.dataRoot, 'data', 'applications.md'), 'utf-8'),
      before,
      'negotiate documents itself as READ-ONLY — the tracker must come back byte-identical',
    );
    assert.deepEqual(readdirSync(f.decoyCwd), [], 'a run wrote into the directory it was launched from');
  } finally { cleanup(f); }
});
