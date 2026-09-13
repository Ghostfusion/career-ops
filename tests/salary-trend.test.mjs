// tests/salary-trend.test.mjs — salary-trend.mjs reads the `advertised_comp`
// band out of every evaluation report's Machine Summary YAML fence, groups the
// bands by role family (fuzzy, company-agnostic) and prints each family's
// observed span plus a median band.
//
// The fixture is a temp data root holding only reports/<ddd>-<slug>.md files
// (the scan is `^\d{3}-.+\.md$`), reached through CAREER_OPS_ROOT, with the
// launch directory a separate decoy. The family aggregates asserted below are
// derived from the fixture bands with the rule the tool documents — min of the
// lows, max of the highs, median of the band midpoints — not copied from a run.
//
// `target` comes from config/profile.yml next to the script, not from the data
// root, so this suite never asserts its value; it only checks the key is there.
//
// Run: node --test tests/salary-trend.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// One fixture report per row: the advertised string and the band it denotes.
const REPORTS = [
  { file: '001-acme-swe.md', role: 'Senior Software Engineer, Applied AI', comp: '$150,000-$200,000', band: [150000, 200000], family: 'swe-ai' },
  { file: '002-globex-swe.md', role: 'Software Engineer', comp: '$120k-$140k', band: [120000, 140000], family: 'swe-ai' },
  { file: '003-initech-pm.md', role: 'Staff Product Manager, Agentic Experiences', comp: '$180,000', band: [180000, 180000], family: 'pm' },
];

/** The documented aggregation of a family's bands. */
function aggregate(bands) {
  const mids = bands.map((b) => (b[0] + b[1]) / 2).sort((a, b) => a - b);
  return {
    count: bands.length,
    min: Math.min(...bands.map((b) => b[0])),
    max: Math.max(...bands.map((b) => b[1])),
    medianBand: mids[(mids.length - 1) >> 1],
  };
}

function expectedFamilies() {
  const map = new Map();
  for (const r of REPORTS) {
    if (!map.has(r.family)) map.set(r.family, []);
    map.get(r.family).push(r.band);
  }
  return [...map.entries()]
    .map(([family, bands]) => ({ family, ...aggregate(bands) }))
    .sort((a, b) => b.count - a.count);
}

function reportText(r) {
  return ['# Evaluation', '', '```yaml', `role: ${r.role}`, `advertised_comp: ${r.comp}`, '```', ''].join('\n');
}

function fixture({ withReports = true } = {}) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-salarytrend-'));
  const decoyCwd = mkdtempSync(join(tmpdir(), 'career-ops-salarytrend-cwd-'));
  if (withReports) {
    mkdirSync(join(dataRoot, 'reports'), { recursive: true });
    for (const r of REPORTS) writeFileSync(join(dataRoot, 'reports', r.file), reportText(r));
  }
  return { dataRoot, decoyCwd };
}

function run(args, f) {
  const r = spawnSync(process.execPath, [join(ROOT, 'salary-trend.mjs'), ...args], {
    cwd: f.decoyCwd,
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, CAREER_OPS_ROOT: f.dataRoot, CAREER_OPS_DATA_DIR: '' },
  });
  assert.equal(r.error, undefined, `spawn failed: ${r.error?.message}`);
  assert.equal(r.status, 0, `exited ${r.status}: ${r.stdout}${r.stderr}`);
  return { ...r, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const cleanup = (f) => {
  for (const d of [f.dataRoot, f.decoyCwd]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
};

test('the built-in self-test verdict passes', () => {
  const f = fixture();
  try {
    const r = run(['--self-test'], f);
    assert.match(r.stdout, /salary-trend self-test: 6\/6 passed/, `self-test verdict:\n${r.all.slice(0, 400)}`);
  } finally { cleanup(f); }
});

test('--json aggregates the advertised bands by role family', () => {
  const f = fixture();
  try {
    const parsed = JSON.parse(run(['--json'], f).stdout);
    assert.ok('target' in parsed, 'the payload no longer carries a target band');
    assert.deepEqual(parsed.families.map((x) => x.family), expectedFamilies().map((x) => x.family), `families:\n${JSON.stringify(parsed.families)}`);
    for (const expected of expectedFamilies()) {
      const got = parsed.families.find((x) => x.family === expected.family);
      assert.ok(got, `family ${expected.family} is missing`);
      assert.equal(got.count, expected.count, `${expected.family} report count`);
      assert.equal(got.min, expected.min, `${expected.family} observed low`);
      assert.equal(got.max, expected.max, `${expected.family} observed high`);
      assert.equal(got.medianBand, expected.medianBand, `${expected.family} median band`);
    }
  } finally { cleanup(f); }
});

test('--family filters to one family and prints its span', () => {
  const f = fixture();
  try {
    const r = run(['--family', 'pm'], f);
    const expected = expectedFamilies().find((x) => x.family === 'pm');
    assert.match(r.stdout, /pm \(1 report\)/, `family heading:\n${r.stdout.slice(0, 400)}`);
    assert.match(
      r.stdout,
      new RegExp(`observed span: \\$${expected.min.toLocaleString('en-US')} \u2013 \\$${expected.max.toLocaleString('en-US')}`),
      `family span:\n${r.stdout.slice(0, 400)}`,
    );
    assert.match(r.stdout, new RegExp(`median: \\$${expected.medianBand.toLocaleString('en-US')}`), `family median:\n${r.stdout.slice(0, 400)}`);
    assert.doesNotMatch(r.stdout, /swe-ai \(/, 'another family leaked into a --family view');
  } finally { cleanup(f); }
});

test('an unknown family is the documented no-matches boundary', () => {
  const f = fixture();
  try {
    const r = run(['--family', 'quantum-chemist'], f);
    assert.match(r.stdout, /no advertised comp data for family "quantum-chemist" in reports yet/, `boundary message:\n${r.all.slice(0, 400)}`);
  } finally { cleanup(f); }
});

test('no reports at all is the documented empty boundary', () => {
  const f = fixture({ withReports: false });
  try {
    const json = JSON.parse(run(['--json'], f).stdout);
    assert.deepEqual(json.families, [], `expected no families:\n${JSON.stringify(json)}`);
    assert.match(run([], f).stdout, /no advertised comp data for any family in reports yet/, 'the empty-boundary message was not printed');
  } finally { cleanup(f); }
});

test('it is read-only: the reports and the launch directory are untouched', () => {
  const f = fixture();
  try {
    const before = readFileSync(join(f.dataRoot, 'reports', REPORTS[0].file), 'utf8');
    run([], f);
    run(['--json'], f);
    run(['--family', 'pm'], f);
    assert.equal(readFileSync(join(f.dataRoot, 'reports', REPORTS[0].file), 'utf8'), before, 'a report was rewritten by a read-only view');
    assert.deepEqual(readdirSync(f.decoyCwd), [], 'something was written into the directory it was launched from');
  } finally { cleanup(f); }
});
