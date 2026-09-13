// tests/negotiate.test.mjs — negotiate.mjs builds one negotiation briefing for
// a single tracker row by coordinating salary-trend / negotiation-roi /
// salary-gap. It exported nothing and had no test.
//
// What is asserted here is negotiate's own contract, not the children's:
//
//   --json      the documented structured payload ({ row, market, roiSummary,
//               statedTrail }) and the row it resolves out of the tracker —
//               through CAREER_OPS_TRACKER, the {root}/applications.md fallback
//               and {root}/data/applications.md alike.
//   --row <n>   the human briefing names that row; an unknown row is null, not
//               a crash (the script has no not-found exit path).
//   roiSummary  stays empty when there is no cv.md — the anti-fabrication gate
//               is that claims are used only when they appear verbatim in it —
//               and comes from the DATA ROOT's story bank when there is one (the
//               checkout's bank is not the user's).
//   --self-test verifies the parts resolve: a data-precondition failure still
//               counts, a child that loads and then crashes does not.
//
// Every run happens in a child with the data root and the cwd pointed at
// DIFFERENT temp directories; the fixture data root never contains a cv.md
// unless a case writes one, so the checkout's own cv.md can never leak in.
//
// Run:  node --test tests/negotiate.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, copyFileSync } from 'node:fs';
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

function run(args, { dataRoot, decoyCwd }, envExtra = {}, script = join(ROOT, 'negotiate.mjs')) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: decoyCwd,
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, CAREER_OPS_ROOT: dataRoot, CAREER_OPS_DATA_DIR: '', CAREER_OPS_TRACKER: '', ...envExtra },
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
    assert.match(r.stdout, /negotiate 3\/3 passed/, `unexpected self-test verdict:\n${r.all.slice(0, 400)}`);
  } finally { cleanup(f); }
});

test('--row <n> --json returns the documented payload for that tracker row', () => {
  const f = fixture();
  try {
    const r = run(['--row', '2', '--json'], f);
    assert.equal(r.status, 0, `exited ${r.status}:\n${r.all.slice(0, 400)}`);
    const p = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(p).sort(), ['market', 'roiSummary', 'row', 'statedTrail'], `payload shape changed:\n${r.stdout.slice(0, 300)}`);
    assert.deepEqual(p.row, { company: 'Globex', role: 'ML Engineer', status: 'Interview' }, 'the row must be read from the tracker');
    assert.ok(Array.isArray(p.market?.families), `market is salary-trend --json:\n${r.stdout.slice(0, 300)}`);
    assert.equal(typeof p.roiSummary, 'string');
    assert.equal(typeof p.statedTrail, 'string');
    assert.match(p.statedTrail, /"num":\s*"2"/, 'the stated-comp trail must be looked up for the requested row');
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
    assert.match(
      r.stdout,
      /Stated-comp trail \(what this row has already told interviewers\):/,
      'the salary-gap section must say what it actually is — salary-gap has no per-row gap view',
    );
    assert.doesNotMatch(r.stdout, /Comp gap:/, 'the heading still promises a desired/advertised/actual gap');
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

const TRACKER_ROW_7 = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|---|---|---|---|---|---|---|---|',
  '| 7 | 2026-03-01 | Umbrella | Platform Engineer | 4.5/5 | Offer | ✅ | | n |',
  '',
].join('\n');

test('--row finds a row through CAREER_OPS_TRACKER and through the root fallback', () => {
  // roleForRow read {root}/data/applications.md directly, so the documented
  // CAREER_OPS_TRACKER override (and the {root}/applications.md fallback every
  // sibling tool honours) returned `"row": null` for a row that exists.
  const f = fixture({ tracker: false });
  const overrideDir = mkdtempSync(join(tmpdir(), 'career-ops-negotiate-override-'));
  try {
    const override = join(overrideDir, 'applications.md');
    writeFileSync(override, TRACKER_ROW_7);
    const viaEnv = JSON.parse(run(['--row', '7', '--json'], f, { CAREER_OPS_TRACKER: override }).stdout);
    assert.deepEqual(
      viaEnv.row,
      { company: 'Umbrella', role: 'Platform Engineer', status: 'Offer' },
      'the CAREER_OPS_TRACKER override was ignored',
    );

    writeFileSync(join(f.dataRoot, 'applications.md'), TRACKER_ROW_7);
    const viaFallback = JSON.parse(run(['--row', '7', '--json'], f).stdout);
    assert.deepEqual(
      viaFallback.row,
      { company: 'Umbrella', role: 'Platform Engineer', status: 'Offer' },
      'the {root}/applications.md fallback was ignored',
    );
  } finally {
    rmSync(overrideDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    cleanup(f);
  }
});

const CV_FIXTURE = [
  '# Fixture Candidate',
  '',
  '- Cut onboarding paperwork processing from 8 hours to 2 hours per batch.',
  '',
].join('\n');

const STORY_BANK_FIXTURE = [
  '### [Efficiency] Fixture onboarding automation',
  '',
  '**Source:** fixture data root',
  '',
  '**S (Situation):** Onboarding paperwork is manual.',
  '',
  '**T (Task):** Cut the time it takes.',
  '',
  '**A (Action):** I cut onboarding paperwork processing from 8 hours to 2 hours per batch, done weekly, at $45/hr.',
  '',
  '**R (Result):** Faster onboarding.',
  '',
  '**Reflection:** Template automation.',
  '',
  '**Best for questions about:** efficiency',
  '',
].join('\n');

test('the ROI summary is built from the data root story bank, not the checkout\'s', () => {
  // negotiation-roi built STORY_BANK_PATH from its own module directory while
  // cv.md came from the data root, so with CAREER_OPS_ROOT set it scanned the
  // CHECKOUT's bank: two runs against different fixture roots printed
  // byte-identical output ("Stories scanned: 86"). The fixture bank here holds
  // exactly one story.
  const f = fixture();
  try {
    writeFileSync(join(f.dataRoot, 'cv.md'), CV_FIXTURE);
    mkdirSync(join(f.dataRoot, 'interview-prep'), { recursive: true });
    writeFileSync(join(f.dataRoot, 'interview-prep', 'story-bank.md'), STORY_BANK_FIXTURE);

    const p = JSON.parse(run(['--row', '2', '--json'], f).stdout);
    assert.match(p.roiSummary, /Stories scanned: 1\b/, `the data root's bank was not the one read:\n${p.roiSummary.slice(0, 300)}`);
    assert.match(p.roiSummary, /Draft talking points/, `the verified, calculable claim was not drafted:\n${p.roiSummary.slice(0, 300)}`);
    assert.match(p.roiSummary, /6h × \$45\/hr × 52\/year = \$14,040\/year/, `wrong ROI math:\n${p.roiSummary.slice(0, 300)}`);
  } finally { cleanup(f); }
});

test('--self-test fails when a dependency loads and then crashes', () => {
  // Stand-ins for the three children in a throwaway tools directory: the crash
  // is real without editing a checkout file. resolves() used to return true for
  // every non-zero exit except a module-resolution error, so the third child
  // still printed "resolves" and the verdict read 3/3.
  const toolsDir = mkdtempSync(join(tmpdir(), 'career-ops-negotiate-tools-'));
  const decoy = mkdtempSync(join(tmpdir(), 'career-ops-negotiate-tools-cwd-'));
  try {
    copyFileSync(join(ROOT, 'negotiate.mjs'), join(toolsDir, 'negotiate.mjs'));
    copyFileSync(join(ROOT, 'path-resolver.mjs'), join(toolsDir, 'path-resolver.mjs'));
    // loads and exits 0 → resolves
    writeFileSync(join(toolsDir, 'salary-trend.mjs'), 'console.log(JSON.stringify({ target: null, families: [] }));\n');
    // the tool's own documented data-precondition failure → still resolves
    writeFileSync(join(toolsDir, 'negotiation-roi.mjs'), [
      'console.error("Error: /tmp/fixture/story-bank.md not found.");',
      'console.error("Run /career-ops interview-prep on a role first to populate your story bank.");',
      'throw new Error("data precondition");',
      '',
    ].join('\n'));
    // loads, then crashes at startup → must NOT resolve
    writeFileSync(join(toolsDir, 'salary-gap.mjs'), [
      'console.error("SyntaxError: The requested module ./x.mjs does not provide an export named y");',
      'throw new Error("crashed at startup");',
      '',
    ].join('\n'));

    const r = run(['--self-test'], { dataRoot: toolsDir, decoyCwd: decoy }, {}, join(toolsDir, 'negotiate.mjs'));
    assert.equal(r.status, 1, `a crashed dependency must fail the self-test:\n${r.all.slice(0, 500)}`);
    assert.match(r.stdout, /negotiate 2\/3 passed/, `verdict line:\n${r.all.slice(0, 500)}`);
    assert.match(r.stdout, /❌ salary-gap resolves/, `the crashed child must be the reported failure:\n${r.all.slice(0, 500)}`);
    assert.match(r.stdout, /✅ negotiation-roi resolves/, 'a documented data-precondition failure still counts as resolved');
  } finally {
    for (const d of [toolsDir, decoy]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
