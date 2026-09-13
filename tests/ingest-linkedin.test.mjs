// tests/ingest-linkedin.test.mjs — ingest-linkedin.mjs turns a pasted LinkedIn
// job-alert body (or a file) into `- [ ] {url}` pending rows in the data-root
// pipeline inbox, and is documented to never touch the tracker.
//
// It resolves its data root with getCareerOpsRoot(), so every case here runs the
// child with CAREER_OPS_ROOT pointing at a fixture and the cwd at a DIFFERENT
// decoy directory: a path following the cwd or the checkout finds nothing,
// and the decoy must come back empty.
//
// Run:  node --test tests/ingest-linkedin.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = 'ingest-linkedin.mjs';

function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-ingest-linkedin-'));
  const decoyCwd = mkdtempSync(join(tmpdir(), 'career-ops-ingest-linkedin-cwd-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  writeFileSync(join(dataRoot, 'data', 'applications.md'), [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|---|---|---|---|---|---|---|---|',
    '| 1 | 2026-01-05 | Acme | Backend Engineer | 4.2/5 | Applied | \u2705 | [1](r1.md) | n |',
    '',
  ].join('\n'));
  writeFileSync(join(dataRoot, 'data', 'pipeline.md'), [
    '# Pipeline — Pending URLs',
    '',
    '## Pending',
    '',
    '- [ ] https://www.linkedin.com/jobs/view/999',
    '',
  ].join('\n'));
  return { dataRoot, decoyCwd };
}

function run(scriptArgs, { dataRoot, decoyCwd }) {
  const r = spawnSync(process.execPath, [join(ROOT, SCRIPT), ...scriptArgs], {
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

const pipelineOf = (f) => readFileSync(join(f.dataRoot, 'data', 'pipeline.md'), 'utf8');
const trackerOf = (f) => readFileSync(join(f.dataRoot, 'data', 'applications.md'), 'utf8');

test('--self-test exits 0 with its own 4/4 verdict', () => {
  const f = fixture();
  try {
    const r = run(['--self-test'], f);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /ingest-linkedin self-test: 4\/4 passed/);
  } finally { cleanup(f); }
});

test('--json returns the deduped LinkedIn links only, and writes nothing', () => {
  const f = fixture();
  try {
    const before = pipelineOf(f);
    const text = 'see https://www.linkedin.com/jobs/view/111 and https://www.linkedin.com/jobs/view/111 '
      + 'plus https://lnkd.in/abcd and https://example.com/jobs/view/1';
    const r = run(['--json', '--text', text], f);
    assert.equal(r.status, 0, r.all);
    assert.deepEqual(JSON.parse(r.stdout), [
      'https://www.linkedin.com/jobs/view/111',
      'https://lnkd.in/abcd',
    ]);
    assert.equal(pipelineOf(f), before, '--json must not write the pipeline');
    assert.deepEqual(readdirSync(f.decoyCwd), [], 'a script wrote into the directory it was launched from');
  } finally { cleanup(f); }
});

test('appends only links not already pending, into the data-root pipeline', () => {
  const f = fixture();
  try {
    const text = 'a https://www.linkedin.com/jobs/view/999 b https://www.linkedin.com/jobs/view/222 c';
    const r = run(['--text', text], f);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /added 1 LinkedIn job link\(s\) to pipeline \(1 already present\)/);
    const pipeline = pipelineOf(f);
    assert.match(pipeline, /- \[ \] https:\/\/www\.linkedin\.com\/jobs\/view\/222/);
    assert.equal(
      (pipeline.match(/jobs\/view\/999/g) || []).length,
      1,
      'an already-pending URL must not be duplicated',
    );
    assert.deepEqual(readdirSync(f.decoyCwd), [], 'a script wrote into the directory it was launched from');
  } finally { cleanup(f); }
});

test('an alert whose links are all already pending is a reported no-op', () => {
  const f = fixture();
  try {
    const before = pipelineOf(f);
    const r = run(['--text', 'only https://www.linkedin.com/jobs/view/999 here'], f);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /all alert links already present in pipeline/);
    assert.equal(pipelineOf(f), before, 'the pipeline must be byte-identical when nothing is fresh');
  } finally { cleanup(f); }
});

test('reads an alert body from --file', () => {
  const f = fixture();
  try {
    const alert = join(f.decoyCwd, 'alert.txt');
    writeFileSync(alert, 'x https://www.linkedin.com/jobs/view/444 y');
    const r = run(['--file', alert], f);
    assert.equal(r.status, 0, r.all);
    assert.match(pipelineOf(f), /- \[ \] https:\/\/www\.linkedin\.com\/jobs\/view\/444/);
  } finally { cleanup(f); }
});

test('an alert with no LinkedIn links is a reported no-op', () => {
  const f = fixture();
  try {
    const before = pipelineOf(f);
    const r = run(['--text', 'nothing to see here'], f);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /no LinkedIn job links found in the alert/);
    assert.equal(pipelineOf(f), before);
  } finally { cleanup(f); }
});

test('never writes the tracker', () => {
  const f = fixture();
  try {
    const before = trackerOf(f);
    run(['--text', 'https://www.linkedin.com/jobs/view/333'], f);
    assert.equal(trackerOf(f), before, 'ingest-linkedin must only append to the pipeline inbox');
  } finally { cleanup(f); }
});

test('a missing --file is the documented exit 2', () => {
  const f = fixture();
  try {
    const r = run(['--file', join(f.decoyCwd, 'does-not-exist.txt')], f);
    assert.equal(r.status, 2, r.all);
    assert.match(r.stderr, /cannot read file:/);
  } finally { cleanup(f); }
});

test('no input at all is the documented usage error and exit 1', () => {
  const f = fixture();
  try {
    const before = pipelineOf(f);
    const r = run([], f);
    assert.equal(r.status, 1, r.all);
    assert.match(r.stderr, /Usage: --text "<body>" \| --file alert\.txt \| --json/);
    assert.equal(pipelineOf(f), before, 'the usage error must not write the pipeline');
  } finally { cleanup(f); }
});
