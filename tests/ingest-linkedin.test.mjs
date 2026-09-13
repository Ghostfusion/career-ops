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
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The same lock the other writers of data/pipeline.md take (scan.mjs's
// appendToPipeline, plugins.mjs, rank-pipeline.mjs). Held here to make the
// concurrent-write case below deterministic.
import { withPipelineLock } from '../pipeline-lock.mjs';

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

// The child always gets the fixture data root and a DIFFERENT cwd.
const env = (dataRoot) => ({ ...process.env, CAREER_OPS_ROOT: dataRoot, CAREER_OPS_DATA_DIR: '' });

function run(scriptArgs, { dataRoot, decoyCwd }) {
  const r = spawnSync(process.execPath, [join(ROOT, SCRIPT), ...scriptArgs], {
    cwd: decoyCwd,
    encoding: 'utf-8',
    timeout: 60_000,
    env: env(dataRoot),
  });
  assert.equal(r.error, undefined, `spawn failed: ${r.error?.message}`);
  return { ...r, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const cleanup = (f) => {
  for (const d of [f.dataRoot, f.decoyCwd]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
};

const pipelineOf = (f) => readFileSync(join(f.dataRoot, 'data', 'pipeline.md'), 'utf8');
const trackerOf = (f) => readFileSync(join(f.dataRoot, 'data', 'applications.md'), 'utf8');

test('--self-test exits 0 with its own 7/7 verdict', () => {
  const f = fixture();
  try {
    const r = run(['--self-test'], f);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /ingest-linkedin self-test: 7\/7 passed/);
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

test('a URL that ends a sentence is written without the sentence punctuation', () => {
  const f = fixture();
  try {
    const r = run(['--text', 'Apply at https://www.linkedin.com/jobs/view/4012345678.'], f);
    assert.equal(r.status, 0, r.all);
    const pipeline = pipelineOf(f);
    assert.match(
      pipeline,
      /- \[ \] https:\/\/www\.linkedin\.com\/jobs\/view\/4012345678\n/,
      `the trailing period was kept in the written URL:\n${pipeline}`,
    );
    assert.doesNotMatch(pipeline, /4012345678\./, 'a broken link (URL + punctuation) was written into the pipeline');
  } finally { cleanup(f); }
});

test('--json strips trailing punctuation but keeps query strings and trailing slashes', () => {
  const f = fixture();
  try {
    const text = 'x https://www.linkedin.com/jobs/view/1/?refId=abc&trk=xyz, y https://www.linkedin.com/jobs/view/2/. z';
    const r = run(['--json', '--text', text], f);
    assert.equal(r.status, 0, r.all);
    assert.deepEqual(JSON.parse(r.stdout), [
      'https://www.linkedin.com/jobs/view/1/?refId=abc&trk=xyz',
      'https://www.linkedin.com/jobs/view/2/',
    ]);
  } finally { cleanup(f); }
});

test('an existing ## Pendientes section is appended to, not duplicated with ## Pending', () => {
  // scan.mjs keeps both markers (older/translated files say `## Pendientes`, and
  // scan-ats-full.mjs auto-creates that spelling). Matching the exact line
  // '## Pending' made this run add a second, empty section instead.
  const f = fixture();
  try {
    writeFileSync(join(f.dataRoot, 'data', 'pipeline.md'), [
      '# Pipeline — Pending URLs', '', '## Pendientes', '',
      '- [ ] https://www.linkedin.com/jobs/view/999', '',
    ].join('\n'));
    const r = run(['--text', 'x https://www.linkedin.com/jobs/view/555 y'], f);
    assert.equal(r.status, 0, r.all);
    const lines = pipelineOf(f).split('\n').map((l) => l.trim());
    assert.ok(lines.includes('- [ ] https://www.linkedin.com/jobs/view/555'), `the link was not added:\n${r.all.slice(0, 300)}`);
    assert.equal(lines.filter((l) => l === '## Pending').length, 0, 'a second, English Pending section was appended');
    assert.equal(lines.filter((l) => l === '## Pendientes').length, 1, 'the existing Pendientes section must be the one used');
  } finally { cleanup(f); }
});

test('a CRLF pipeline matches its Pending section too', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dataRoot, 'data', 'pipeline.md'), [
      '# Pipeline — Pending URLs', '', '## Pendientes', '',
      '- [ ] https://www.linkedin.com/jobs/view/999', '',
    ].join('\r\n'));
    const r = run(['--text', 'x https://www.linkedin.com/jobs/view/666 y'], f);
    assert.equal(r.status, 0, r.all);
    const lines = pipelineOf(f).split('\n').map((l) => l.trim());
    assert.ok(lines.includes('- [ ] https://www.linkedin.com/jobs/view/666'), `the link was not added:\n${r.all.slice(0, 300)}`);
    assert.equal(lines.filter((l) => l === '## Pendientes').length, 1, 'the CRLF marker line was not recognized');
    assert.equal(lines.filter((l) => l === '## Pending').length, 0, 'a second Pending section was appended to a CRLF file');
  } finally { cleanup(f); }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitExit = (child) => new Promise((resolve) => child.once('exit', (code) => resolve(code)));

test('a concurrent write to the pipeline is not lost: the append takes the pipeline lock', async () => {
  // Stands in for scan.mjs's appendToPipeline / plugins.mjs / rank-pipeline.mjs:
  // take the lock FIRST, snapshot the file (the read half of a real
  // read-modify-write), start the ingest child, let it run, then write our row.
  // A child that honours the lock cannot read the file until after that write,
  // so it re-reads and keeps our row. The unlocked version read the pre-write
  // snapshot, spliced, and wrote it back — erasing the row we added here.
  const f = fixture();
  const pipelinePath = join(f.dataRoot, 'data', 'pipeline.md');
  let child;
  try {
    let childExit;
    await withPipelineLock(pipelinePath, async () => {
      const snapshot = pipelineOf(f);
      child = spawn(process.execPath, [join(ROOT, SCRIPT), '--text', 'x https://www.linkedin.com/jobs/view/222 y'], {
        cwd: f.decoyCwd,
        env: env(f.dataRoot),
      });
      childExit = waitExit(child);
      // An unlocked child finishes here and its row appears; a locked one is
      // still blocked, so the poll simply runs to its deadline.
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline && !pipelineOf(f).includes('jobs/view/222')) await sleep(50);
      writeFileSync(pipelinePath, `${snapshot}- [ ] https://www.linkedin.com/jobs/view/777\n`);
    });
    assert.equal(await childExit, 0, 'the ingest child failed');
    const pipeline = pipelineOf(f);
    assert.match(pipeline, /- \[ \] https:\/\/www\.linkedin\.com\/jobs\/view\/777/, `the concurrent row is missing:\n${pipeline}`);
    assert.match(pipeline, /- \[ \] https:\/\/www\.linkedin\.com\/jobs\/view\/222/, `the child's row was erased by the concurrent write:\n${pipeline}`);
  } finally {
    if (child && child.exitCode === null) child.kill();
    cleanup(f);
  }
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
