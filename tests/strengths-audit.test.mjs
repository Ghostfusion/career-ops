// tests/strengths-audit.test.mjs — strengths-audit.mjs, the periodic proof that
// the CV is getting stronger: proof-points counts, section presence, and an
// advisory fact-check pass.
//
// Both inputs are the user's, under the data root: cv.md and
// data/proof-points.tsv. The audit is advertised as advisory — "the audit never
// fails" — so the missing-input boundary is a clean exit 0, not an error.
//
// Run:  node --test tests/strengths-audit.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const CV_MD = [
  '# Vincent Liu',
  '',
  '## Professional Summary',
  '',
  'Enterprise AI builder.',
  '',
  '## Skills',
  '',
  '- LLM engineering',
  '',
  '## Work Experience',
  '',
  '- 15 years of delivery',
  '',
].join('\n');

const PROOF_POINTS = [
  'name\tstatus\tstrength',
  'published-talk\tpublished\t5',
  'oss-release\tpublished\t4',
  'draft-post\tdraft\t3',
  '',
].join('\n');

function fixture({ cv = CV_MD, proofPoints = PROOF_POINTS } = {}) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-strengths-'));
  const decoyCwd = mkdtempSync(join(tmpdir(), 'career-ops-strengths-cwd-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  if (cv !== null) writeFileSync(join(dataRoot, 'cv.md'), cv);
  if (proofPoints !== null) writeFileSync(join(dataRoot, 'data', 'proof-points.tsv'), proofPoints);
  return { dataRoot, decoyCwd };
}

function run(args, { dataRoot, decoyCwd }) {
  const r = spawnSync(process.execPath, [join(ROOT, 'strengths-audit.mjs'), ...args], {
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

test('--self-test reports its own verdict', () => {
  const f = fixture();
  try {
    const r = run(['--self-test'], f);
    assert.equal(r.status, 0, `self-test exited ${r.status}:\n${r.all}`);
    assert.match(r.all, /strengths-audit 3\/3 passed/);
  } finally { cleanup(f); }
});

test('--json counts proof-points and detects the sections actually present in the CV', () => {
  const f = fixture();
  try {
    const r = run(['--json'], f);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.all}`);
    const payload = JSON.parse(r.stdout);
    assert.deepEqual(payload.proofs, { total: 3, published: 2, inprogress: 1 });
    assert.deepEqual(payload.sections, ['Skills', 'Professional Summary', 'Work Experience']);
    assert.ok(Array.isArray(payload.warnings), 'warnings must always be an array');
  } finally { cleanup(f); }
});

test('section detection follows the CV, not a fixed list', () => {
  const f = fixture({ cv: '# CV\n\n## Certifications\n\n- one\n' });
  try {
    const payload = JSON.parse(run(['--json'], f).stdout);
    assert.deepEqual(payload.sections, ['Certifications']);
  } finally { cleanup(f); }
});

test('the human-readable run reports counts, sections and the page-length signal', () => {
  const f = fixture();
  try {
    const r = run([], f);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.all}`);
    assert.match(r.stdout, /^strengths-audit — is your CV getting stronger\?/m);
    assert.match(r.stdout, /proof-points\s+: 3 total \(2 published, 1 in progress\)/);
    assert.match(r.stdout, /CV sections\s+: Skills, Professional Summary, Work Experience/);
    assert.match(r.stdout, /approx length\s+: ~\d+\.\d+k chars/);
    assert.match(r.stdout, /fact check\s+: /);
  } finally { cleanup(f); }
});

test('a missing CV and missing proof-points are an empty audit, not a failure', () => {
  const f = fixture({ cv: null, proofPoints: null });
  try {
    const r = run([], f);
    assert.equal(r.status, 0, `the advisory audit must never fail; exited ${r.status}: ${r.all}`);
    assert.match(r.stdout, /proof-points\s+: 0 total \(0 published, 0 in progress\)/);
    assert.match(r.stdout, /CV sections\s+: none detected/);
    const payload = JSON.parse(run(['--json'], f).stdout);
    assert.deepEqual(payload.proofs, { total: 0, published: 0, inprogress: 0 });
    assert.deepEqual(payload.sections, []);
  } finally { cleanup(f); }
});

test('it never writes — cv.md and the launch cwd come back untouched', () => {
  const f = fixture();
  try {
    const cvPath = join(f.dataRoot, 'cv.md');
    const before = readFileSync(cvPath);
    run([], f);
    run(['--json'], f);
    run(['--self-test'], f);
    assert.deepEqual(readFileSync(cvPath), before);
    assert.deepEqual(readdirSync(f.decoyCwd), [], 'a script wrote into the directory it was launched from');
  } finally { cleanup(f); }
});
