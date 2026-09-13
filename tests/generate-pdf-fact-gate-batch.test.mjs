// tests/generate-pdf-fact-gate-batch.test.mjs — the fact gate must apply to
// `--batch` renders too.
//
// A single render gates the document it is about to print: a CV stating a
// metric its sources do not carry is refused (README/modes/pdf.md call this a
// hard gate, unlike the advisory ATS score). The batch path read cv.md,
// validated section order and normalized text per entry — but never called
// assertFacts, so the same HTML that failed standalone rendered happily through
// `--batch`, which is the cron and batch-tailor route. The gate now runs per
// entry, and --skip-fact-check (previously single-document only) turns it off.
//
// The fixture HTML carries a metric the fixture cv.md does not: that is exactly
// what the gate reports as "metric-like claims absent from sources".
//
// Run:  node test-all.mjs --only generate-pdf-fact-gate-batch

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const CV_MD = [
  '# Fixture Candidate',
  '',
  '## Professional Summary',
  '',
  'Generative AI engineer. No metrics, no tools beyond the ones named here.',
  '',
  '## Experience',
  '',
  '- Built evaluation harnesses for retrieval pipelines.',
  '',
].join('\n');

// `15 years` appears nowhere in cv.md, so the gate must refuse this document.
const CV_HTML = [
  '<!doctype html><html><body>',
  '<h1>Fixture Candidate</h1>',
  '<h2>Professional Summary</h2>',
  '<p>Generative AI engineer with 15 years of enterprise delivery experience.</p>',
  '<h2>Experience</h2>',
  '<p>Built evaluation harnesses for retrieval pipelines.</p>',
  '</body></html>',
].join('\n');

function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-pdffacts-'));
  const decoyCwd = mkdtempSync(join(tmpdir(), 'career-ops-pdffacts-cwd-'));
  mkdirSync(join(dataRoot, 'output'), { recursive: true });
  writeFileSync(join(dataRoot, 'cv.md'), CV_MD);
  writeFileSync(join(dataRoot, 'output', 'cv.html'), CV_HTML);
  writeFileSync(join(dataRoot, 'manifest.json'), JSON.stringify([
    { input: 'output/cv.html', output: 'output/cv.pdf' },
  ], null, 2));
  return { dataRoot, decoyCwd };
}

function runBatch(f, extraArgs = []) {
  const r = spawnSync(process.execPath, [
    join(ROOT, 'generate-pdf.mjs'), `--batch=${join(f.dataRoot, 'manifest.json')}`, ...extraArgs,
  ], {
    cwd: f.decoyCwd,
    encoding: 'utf-8',
    timeout: 120_000,
    env: { ...process.env, CAREER_OPS_ROOT: f.dataRoot, CAREER_OPS_DATA_DIR: '' },
  });
  assert.equal(r.error, undefined, `spawn failed: ${r.error?.message}`);
  return { ...r, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const results = (f) => JSON.parse(readFileSync(join(f.dataRoot, 'manifest.json.results.json'), 'utf-8'));

const cleanup = (f) => {
  for (const d of [f.dataRoot, f.decoyCwd]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
};

test('a batch entry whose CV states an unsourced metric is failed, not rendered', () => {
  const f = fixture();
  try {
    const r = runBatch(f);
    assert.notEqual(r.status, 0, `a failed entry must exit non-zero:\n${r.all.slice(0, 400)}`);
    const entry = results(f)[0];
    assert.equal(entry.ok, false, `the entry rendered despite the fact gate:\n${JSON.stringify(entry)}`);
    assert.match(entry.error, /Fact check failed|absent from sources/, `expected a fact-gate failure:\n${JSON.stringify(entry)}`);
    assert.equal(existsSync(join(f.dataRoot, 'output', 'cv.pdf')), false, 'a refused document must not leave a PDF behind');
  } finally { cleanup(f); }
});

test('--skip-fact-check bypasses the gate for a deliberate batch render', () => {
  const f = fixture();
  try {
    const r = runBatch(f, ['--skip-fact-check']);
    assert.equal(r.error, undefined, `the batch crashed:\n${r.all.slice(0, 400)}`);
    const entry = results(f)[0];
    assert.doesNotMatch(entry.error ?? '', /Fact check failed|absent from sources/, `the flag did not bypass the gate:\n${JSON.stringify(entry)}`);
    if (entry.ok) {
      assert.equal(existsSync(join(f.dataRoot, 'output', 'cv.pdf')), true, 'a rendered entry must leave its PDF');
    } else {
      // The gate is off, so any remaining failure belongs to another stage.
      assert.ok(entry.error, 'a failed entry must say why');
    }
  } finally { cleanup(f); }
});
