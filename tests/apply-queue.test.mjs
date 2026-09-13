// tests/apply-queue.test.mjs — apply-queue.mjs, the "do the thing" layer over
// launchpad's ACT/PREP rows.
//
// Its header states the write contract this suite pins: it reads launchpad
// --json, and the ONLY write it performs — only with an explicit --complete
// <row#> — is recording the apply (set-status + followup-seed) and updating
// data/apply-queue.json. Every other mode is read-only.
//
// The header also draws the usage/not-found line: a missing or non-numeric
// operand for --detail/--draft/--complete is a usage error (exit 1), while a
// row that is not an ACTIVE ACT/PREP row is a not-found (exit 2).
//
// Every run happens in a child process with CAREER_OPS_ROOT pointed at a temp
// data root and the cwd at a DIFFERENT temp dir.
//
// Run:  node test-all.mjs --only apply-queue

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const TRACKER_HEADER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|---|---|---|---|---|---|---|---|',
];

const trackerRow = (num, date, company, role, score, status) =>
  `| ${num} | ${date} | ${company} | ${role} | ${score}/5 | ${status} | ✅ | [${num}](r${num}.md) | n |`;

function reportYaml({ finalDecision, nextAction, comp, hardStops = [], softGaps = [] }) {
  const lines = ['# Evaluation', '', '```yaml', `final_decision: ${finalDecision}`];
  if (comp) lines.push(`advertised_comp: ${comp}`);
  if (nextAction) lines.push(`next_action: ${nextAction}`);
  lines.push('hard_stops:');
  for (const s of hardStops) lines.push(`  - ${s}`);
  lines.push('soft_gaps:');
  for (const s of softGaps) lines.push(`  - ${s}`);
  lines.push('```', '');
  return lines.join('\n');
}

function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-apply-queue-'));
  const decoyCwd = mkdtempSync(join(tmpdir(), 'career-ops-apply-queue-cwd-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  mkdirSync(join(dataRoot, 'reports'), { recursive: true });
  writeFileSync(join(dataRoot, 'data', 'applications.md'), [
    ...TRACKER_HEADER,
    trackerRow(1, '2026-01-05', 'Acme', 'Backend Engineer', '4.6', 'Evaluated'),
    trackerRow(2, '2026-02-05', 'Globex', 'ML Engineer', '4.4', 'Evaluated'),
    trackerRow(3, '2026-03-05', 'Initech', 'Data Engineer', '4.8', 'Evaluated'),
    trackerRow(4, '2026-04-05', 'Umbrella', 'SRE', '4.9', 'Applied'),
    '',
  ].join('\n'));
  writeFileSync(join(dataRoot, 'reports', '1-acme.md'), reportYaml({
    finalDecision: 'Apply', nextAction: 'Submit the application', comp: 'Not stated',
  }));
  writeFileSync(join(dataRoot, 'reports', '2-globex.md'), reportYaml({
    finalDecision: 'Apply', nextAction: 'Publish a demo', softGaps: ['demo'],
  }));
  writeFileSync(join(dataRoot, 'reports', '3-initech.md'), reportYaml({
    finalDecision: 'Skip unless the gate clears', hardStops: ['no visa sponsorship'],
  }));
  return { dataRoot, decoyCwd };
}

test('--complete names the row space, so a foreign Report number cannot block it', () => {
  // set-status treats a bare number as ambiguous between the row counter and the
  // report counter, and a row whose Report cell links a different report number
  // than its own is normal once the counters diverge. Passing the bare number
  // made set-status exit 3 — invisible here because stdio is 'ignore', so
  // --complete failed with "Command failed" and never marked the row.
  const f = fixture();
  try {
    writeFileSync(join(f.dataRoot, 'data', 'applications.md'), [
      ...TRACKER_HEADER,
      '| 1 | 2026-01-05 | Acme | Backend Engineer | 4.6/5 | Evaluated | ❌ | [1](reports/1-acme.md) | n |',
      '| 2 | 2026-02-05 | Globex | ML Engineer | 4.4/5 | Evaluated | ❌ | [12](reports/12-globex.md) | n |',
      '',
    ].join('\n'));

    const r = run(['--complete', '2'], f);
    assert.equal(r.status, 0, `--complete failed on a divergent report number:\n${r.all.slice(0, 400)}`);
    const tracker = readFileSync(join(f.dataRoot, 'data', 'applications.md'), 'utf-8');
    assert.match(tracker, /\| 2 \|.*\| Applied \|/, `row 2 was not marked Applied:\n${tracker.slice(0, 400)}`);
  } finally { cleanup(f); }
});

function run(args, { dataRoot, decoyCwd }) {
  const r = spawnSync(process.execPath, [join(ROOT, 'apply-queue.mjs'), ...args], {
    cwd: decoyCwd,
    encoding: 'utf-8',
    timeout: 60_000,
    // CAREER_OPS_TRACKER is pinned too: every child — apply-queue, the
    // launchpad it shells out to, and the set-status/followup-seed pair behind
    // --complete — resolves the tracker through it first. set-status in
    // particular derives the tracker from its OWN directory (the code root) and
    // ignores CAREER_OPS_ROOT, so without this pin a --complete run would write
    // the real checkout's data/applications.md.
    env: {
      ...process.env,
      CAREER_OPS_ROOT: dataRoot,
      CAREER_OPS_DATA_DIR: '',
      CAREER_OPS_TRACKER: join(dataRoot, 'data', 'applications.md'),
    },
  });
  assert.equal(r.error, undefined, `spawn failed: ${r.error?.message}`);
  return { ...r, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const trackerFor = (f) => join(f.dataRoot, 'data', 'applications.md');
const queueFileFor = (f) => join(f.dataRoot, 'data', 'apply-queue.json');

const cleanup = (f) => {
  for (const d of [f.dataRoot, f.decoyCwd]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
};

test('--self-test proves the launchpad wiring it depends on', () => {
  const f = fixture();
  try {
    const r = run(['--self-test'], f);
    assert.equal(r.status, 0, r.all);
    assert.match(r.all, /apply-queue 2\/2 passed/);
  } finally { cleanup(f); }
});

test('--json surfaces only ACT/PREP rows, with the count matching', () => {
  const f = fixture();
  try {
    const r = run(['--json'], f);
    assert.equal(r.status, 0, r.all);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.count, payload.active.length, 'count disagrees with the active list');
    assert.deepEqual(payload.active.map((x) => x.num), [1, 2], 'the queue is not launchpad order');
    assert.deepEqual(payload.active.map((x) => x.tier), ['ACT', 'PREP']);
    assert.ok(payload.active.every((x) => x.tier === 'ACT' || x.tier === 'PREP'), 'a non-actionable row reached the queue');
    assert.ok(!payload.active.some((x) => x.num === 3), 'a HOLD row reached the queue');
    assert.ok(!payload.active.some((x) => x.num === 4), 'an Applied row reached the queue');
  } finally { cleanup(f); }
});

test('the default view names the active count and the open total', () => {
  const f = fixture();
  try {
    const r = run([], f);
    assert.equal(r.status, 0, r.all);
    assert.match(r.all, /apply queue — 2 row\(s\) ready to act \(of 3 open evaluated\)/);
    assert.match(r.all, /#1 Acme · Backend Engineer · ACT/);
    assert.match(r.all, /#2 Globex · ML Engineer · PREP/);
    assert.doesNotMatch(r.all, /#3 Initech/, 'a HOLD row was listed for action');
  } finally { cleanup(f); }
});

test('--detail prints the prep gating an active row', () => {
  const f = fixture();
  try {
    const r = run(['--detail', '1'], f);
    assert.equal(r.status, 0, r.all);
    assert.match(r.all, /Detail for #1 Acme · Backend Engineer \(ACT\)/);
    assert.match(r.all, /score:\s+4\.6\/5/);
    assert.match(r.all, /blocker:\s+none/);
    assert.match(r.all, /comp:\s+Not stated/);
    assert.match(r.all, /next action: Submit the application/);
  } finally { cleanup(f); }
});

test('--draft prints the coordinator chain and never sends', () => {
  const f = fixture();
  try {
    const r = run(['--draft', '2'], f);
    assert.equal(r.status, 0, r.all);
    assert.match(r.all, /Apply chain for #2 Globex · ML Engineer \(PREP\)/);
    assert.match(r.all, /\/career-ops cover globex/);
    assert.match(r.all, /draft-only/);
    assert.match(r.all, new RegExp(`node apply-queue\\.mjs --complete 2\\b`));
  } finally { cleanup(f); }
});

test('a row that is not ACTIVE is the documented exit 2', () => {
  const f = fixture();
  try {
    for (const args of [['--detail', '3'], ['--draft', '3'], ['--complete', '3'], ['--detail', '99']]) {
      const r = run(args, f);
      assert.equal(r.status, 2, `${args.join(' ')} should be not-found:\n${r.all}`);
      assert.match(r.all, /no ACTIVE row #|is not an ACTIVE/);
    }
  } finally { cleanup(f); }
});

test('a missing or non-numeric operand is the documented usage exit 1', () => {
  const f = fixture();
  try {
    for (const args of [['--detail'], ['--draft', 'abc'], ['--complete', 'abc']]) {
      const r = run(args, f);
      assert.equal(r.status, 1, `${args.join(' ')} should be a usage error:\n${r.all}`);
      assert.match(r.all, /usage: --\w+ <row#>/);
    }
  } finally { cleanup(f); }
});

test('the read-only modes write nothing — no tracker edit, no queue file', () => {
  const f = fixture();
  try {
    const before = readFileSync(trackerFor(f));
    run(['--json'], f);
    run(['--detail', '1'], f);
    run(['--draft', '1'], f);
    run([], f);
    assert.deepEqual(readFileSync(trackerFor(f)), before, 'a read-only mode rewrote the tracker');
    assert.ok(!existsSync(queueFileFor(f)), 'a read-only mode created the queue file');
    assert.deepEqual(readdirSync(f.decoyCwd), [], 'a run wrote into the cwd it was launched from');
  } finally { cleanup(f); }
});

test('--complete is the one write: it marks the row Applied and records it', () => {
  const f = fixture();
  try {
    const r = run(['--complete', '1'], f);
    assert.equal(r.status, 0, r.all);
    assert.match(
      readFileSync(trackerFor(f), 'utf-8'),
      /\| 1 \| 2026-01-05 \| Acme \| Backend Engineer \| 4\.6\/5 \| Applied \|/,
      'the row was not marked Applied',
    );
    const q = JSON.parse(readFileSync(queueFileFor(f), 'utf-8'));
    assert.equal(q.queue.length, 1);
    assert.equal(q.queue[0].num, 1);
    assert.match(q.queue[0].markedAt, /^\d{4}-\d{2}-\d{2}T/);

    // The recorded row is no longer an open Evaluated row, so it leaves the queue.
    assert.deepEqual(JSON.parse(run(['--json'], f).stdout).active.map((x) => x.num), [2]);
  } finally { cleanup(f); }
});

test('no active rows is a clean no-op, not an error', () => {
  const f = fixture();
  try {
    writeFileSync(trackerFor(f), [
      ...TRACKER_HEADER,
      trackerRow(3, '2026-03-05', 'Initech', 'Data Engineer', '4.8', 'Evaluated'),
      '',
    ].join('\n'));
    const r = run([], f);
    assert.equal(r.status, 0, r.all);
    assert.match(r.all, /no ACTIVE launchpad rows — run launchpad first/);
    const j = run(['--json'], f);
    assert.equal(j.status, 0, j.all);
    assert.deepEqual(JSON.parse(j.stdout), { count: 0, active: [] });
  } finally { cleanup(f); }
});
