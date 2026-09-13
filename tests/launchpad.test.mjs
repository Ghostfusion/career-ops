// tests/launchpad.test.mjs — launchpad.mjs, the zero-LLM triage that turns
// evaluated-but-unactioned tracker rows into a prioritized queue.
//
// The script's header makes two promises this suite pins:
//   * it NEVER writes the tracker — status transitions belong to set-status.mjs;
//     the only object it may write is data/launchpad-state.json, and only on an
//     explicit --dismiss/--reedit call.
//   * exit codes 0 ok · 1 usage/parse · 2 not-found/bad selector · 4 state write failure.
//
// Every run happens in a child process with CAREER_OPS_ROOT pointed at a temp
// data root and the cwd at a DIFFERENT temp dir, so a path that follows the
// checkout or the cwd finds nothing and the invariant assertions mean something.
//
// Run:  node test-all.mjs --only launchpad

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

// The evaluation-report shape readReportYaml()/classifyBlocker() consume: a yaml
// fence with scalar keys and `- item` lists.
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
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-launchpad-'));
  const decoyCwd = mkdtempSync(join(tmpdir(), 'career-ops-launchpad-cwd-'));
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

function run(args, { dataRoot, decoyCwd }) {
  const r = spawnSync(process.execPath, [join(ROOT, 'launchpad.mjs'), ...args], {
    cwd: decoyCwd,
    encoding: 'utf-8',
    timeout: 60_000,
    // CAREER_OPS_TRACKER is pinned too: the scripts resolve the tracker through
    // it first, so a tracker override inherited from the developer's shell can
    // never point a run at their real data/.
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

const statePathFor = (f) => join(f.dataRoot, 'data', 'launchpad-state.json');
const trackerFor = (f) => join(f.dataRoot, 'data', 'applications.md');

const cleanup = (f) => {
  for (const d of [f.dataRoot, f.decoyCwd]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
};

test('--self-test is green (the tier/blocker contract the script ships with)', () => {
  const f = fixture();
  try {
    const r = run(['--self-test'], f);
    assert.equal(r.status, 0, r.all);
    assert.match(r.all, /launchpad self-test: 9\/9 passed/);
  } finally { cleanup(f); }
});

test('--json classifies open evaluated rows into tiers, honoring blockers', () => {
  const f = fixture();
  try {
    const r = run(['--json'], f);
    assert.equal(r.status, 0, r.all);
    const rows = JSON.parse(r.stdout);
    assert.ok(Array.isArray(rows), 'payload is not the documented tier list');

    // Priority-ordered by score, and tier reflects score + blocker precedence:
    // 4.8 + structural → HOLD, 4.6 clear → ACT, 4.4 + fixable → PREP.
    assert.deepEqual(rows.map((x) => x.num), [3, 1, 2], 'rows are not ordered by score');
    assert.deepEqual(rows.map((x) => x.score), [4.8, 4.6, 4.4]);
    assert.deepEqual(rows.map((x) => x.tier), ['HOLD', 'ACT', 'PREP']);
    assert.deepEqual(rows.map((x) => x.blocker), ['structural', null, 'fixable']);

    // Only Evaluated rows are open; the Applied row never enters the queue.
    assert.ok(!rows.some((x) => x.num === 4), 'an Applied row was queued');

    const acme = rows.find((x) => x.num === 1);
    assert.equal(acme.company, 'Acme');
    assert.equal(acme.role, 'Backend Engineer');
    assert.equal(acme.date, '2026-01-05');
    assert.match(acme.reportPath, /1-acme\.md$/);
    assert.equal(acme.nextAction, 'Submit the application');
    assert.equal(acme.comp, 'Not stated');

    assert.deepEqual(rows.find((x) => x.num === 2).softGaps, ['demo']);
    assert.deepEqual(rows.find((x) => x.num === 3).hardStops, ['no visa sponsorship']);
  } finally { cleanup(f); }
});

test('--summary lists every open row once, in score order', () => {
  const f = fixture();
  try {
    const r = run(['--summary'], f);
    assert.equal(r.status, 0, r.all);
    assert.match(r.all, /HOLD #3/);
    assert.match(r.all, /ACT {2}#1/);
    assert.match(r.all, /PREP #2/);
    assert.ok(r.all.indexOf('HOLD') < r.all.indexOf('ACT'), 'the top row is not listed first');
    assert.ok(r.all.indexOf('ACT') < r.all.indexOf('PREP'), 'the summary is not in score order');
    assert.doesNotMatch(r.all, /Umbrella/, 'a non-Evaluated row was summarized');
  } finally { cleanup(f); }
});

test('--dismiss/--reedit round-trips through data/launchpad-state.json only', () => {
  const f = fixture();
  const tracker = trackerFor(f);
  try {
    const before = readFileSync(tracker);

    const d = run(['--dismiss', '1', '2'], f);
    assert.equal(d.status, 0, d.all);
    const state = JSON.parse(readFileSync(statePathFor(f), 'utf-8'));
    assert.deepEqual(state.dismissed, [1, 2]);
    assert.match(state.updated, /^\d{4}-\d{2}-\d{2}T/);

    const afterDismiss = JSON.parse(run(['--json'], f).stdout);
    assert.deepEqual(afterDismiss.map((x) => x.num), [3], 'dismissed rows still counted as open');

    const re = run(['--reedit', '1'], f);
    assert.equal(re.status, 0, re.all);
    assert.deepEqual(JSON.parse(readFileSync(statePathFor(f), 'utf-8')).dismissed, [2]);
    const afterReedit = JSON.parse(run(['--json'], f).stdout);
    assert.deepEqual(afterReedit.map((x) => x.num), [3, 1], '--reedit did not restore the row');

    // The invariant the header states: the tracker is never written here.
    assert.deepEqual(readFileSync(tracker), before, 'launchpad wrote data/applications.md');
    assert.deepEqual(readdirSync(f.decoyCwd), [], 'launchpad wrote into the cwd it was launched from');
  } finally { cleanup(f); }
});

test('--reedit without a row is a usage error and writes nothing', () => {
  // The old code rewrote the state unchanged and printed `un-dismissed ` with an
  // empty list — --dismiss had the guard, --reedit did not.
  const f = fixture();
  try {
    const r = run(['--reedit'], f);
    assert.equal(r.status, 2, `expected the documented usage exit:\n${r.all.slice(0, 300)}`);
    assert.match(r.all, /Usage: node launchpad\.mjs --reedit/, 'the usage line must name the operand');
    assert.equal(existsSync(statePathFor(f)), false, 'a usage error must not create the state file');
    assert.deepEqual(readdirSync(f.decoyCwd), [], 'launchpad wrote into the cwd it was launched from');
  } finally { cleanup(f); }
});

test('a missing tracker is the documented exit 2, not a raw ENOENT stack', () => {
  const f = fixture();
  try {
    rmSync(trackerFor(f), { force: true });
    const r = run([], f);
    assert.equal(r.status, 2, `expected the documented not-found exit:\n${r.all.slice(0, 400)}`);
    assert.match(r.all, /no tracker found at/, 'the message must name the missing path');
    assert.doesNotMatch(r.all, /ENOENT|node:fs:/, 'a raw stack trace is not a contract');
  } finally { cleanup(f); }
});

test('a bad selector is the documented exit 2 and writes no state', () => {
  const f = fixture();
  try {
    for (const args of [['--dismiss'], ['--dismiss', 'abc']]) {
      const r = run(args, f);
      assert.equal(r.status, 2, `${args.join(' ')} should be a bad selector:\n${r.all}`);
      assert.match(r.all, /Usage: node launchpad\.mjs --dismiss <rowNums/);
    }
    assert.ok(!existsSync(statePathFor(f)), 'a rejected selector still wrote the state file');
    assert.deepEqual(readdirSync(f.decoyCwd), [], 'a rejected run wrote into the cwd');
  } finally { cleanup(f); }
});

test('an empty queue is not an error: [] payload and a clean human view', () => {
  const f = fixture();
  try {
    writeFileSync(trackerFor(f), [
      ...TRACKER_HEADER,
      trackerRow(9, '2026-05-05', 'Vandelay', 'QA Engineer', '3.0', 'Discarded'),
      '',
    ].join('\n'));

    const j = run(['--json'], f);
    assert.equal(j.status, 0, j.all);
    assert.deepEqual(JSON.parse(j.stdout), []);

    const human = run([], f);
    assert.equal(human.status, 0, human.all);
    assert.match(human.all, /0 dismissed \(none\)/);
    assert.doesNotMatch(human.all, /🟢|🟠|🟡|⚫/, 'a tier group was rendered with no open rows');
  } finally { cleanup(f); }
});
