// tests/user-layer-paths.test.mjs — tools that read user-layer files by a path
// literal rather than by the data root.
//
// Found by exercising every feature in a sandbox: four tools resolved a
// user-layer file from somewhere other than the data root, so with
// CAREER_OPS_ROOT / CAREER_OPS_DATA_DIR set (or simply a different cwd) they
// either failed on a file that exists or wrote where the guard then refused:
//
//   match-star.mjs     STORY_BANK_PATH = 'interview-prep/story-bank.md'  (cwd)
//   jd-skill-gap.mjs   CV_PATH = 'cv.md'                                 (cwd)
//   contacts.mjs       the --vcf containment guard was anchored to the CODE
//                      directory, so the documented target under the data root
//                      was refused outright
//   doctor.mjs         the onboarding template copy never created modes/, so a
//                      fresh data root silently lost the three modes/_*.md
//                      templates (only root-level voice-dna.md landed)
//
// Every case runs the real script with the data root and the cwd pointing at
// DIFFERENT directories, so following either one is visible.
//
// Run:  node test-all.mjs --only user-layer-paths

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const TRACKER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|---|---|---|---|---|---|---|---|',
  '| 1 | 2026-01-05 | Northwind Analytics | Senior Software Engineer | 4.2/5 | Applied | ❌ | [1](reports/001-northwind-2026-01-05.md) | n |',
  '',
].join('\n');

const STORY_BANK = [
  '# Story Bank',
  '',
  '### [Agents & Automation] Cut handoff time',
  '**Source:** reports/001-northwind-2026-01-05.md',
  '**S (Situation):** a silo doc pipeline',
  '**T (Task):** own the migration',
  '**A (Action):** scoped three teams',
  '**R (Result):** 40% faster handoff',
  '**Reflection:** orchestration',
  '',
].join('\n');

function fixture({ modes = true, storyBank = true, contacts = true } = {}) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-userlayer-'));
  const decoyCwd = mkdtempSync(join(tmpdir(), 'career-ops-userlayer-cwd-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
  mkdirSync(join(dataRoot, 'interview-prep'), { recursive: true });
  writeFileSync(join(dataRoot, 'data', 'applications.md'), TRACKER);
  writeFileSync(join(dataRoot, 'cv.md'), '# Professional Summary\n\nBuilt evaluation harnesses for retrieval pipelines.\n');
  writeFileSync(join(dataRoot, 'config', 'profile.yml'), 'target_range: "$150,000-$200,000"\n');
  if (storyBank) writeFileSync(join(dataRoot, 'interview-prep', 'story-bank.md'), STORY_BANK);
  if (contacts) writeFileSync(join(dataRoot, 'data', 'contacts.tsv'), 'name\tcompany\trole\tlinkedin\tnotes\nAcme Recruiter\tAcme\tRecruiter\t\tmet at meetup\n');
  if (modes) mkdirSync(join(dataRoot, 'modes'), { recursive: true });
  return { dataRoot, decoyCwd };
}

function run(script, args, f) {
  const r = spawnSync(process.execPath, [join(ROOT, script), ...args], {
    cwd: f.decoyCwd,
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, CAREER_OPS_ROOT: f.dataRoot, CAREER_OPS_DATA_DIR: '', CAREER_OPS_TRACKER: '' },
  });
  assert.equal(r.error, undefined, `spawn failed: ${r.error?.message}`);
  return { ...r, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const cleanup = (f) => {
  for (const d of [f.dataRoot, f.decoyCwd]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
};

test('match-star reads the story bank from the data root, not the cwd', () => {
  const f = fixture();
  try {
    const r = run('match-star.mjs', ['--list'], f);
    assert.equal(r.status, 0, `match-star failed off the data root:\n${r.all.slice(0, 300)}`);
    assert.doesNotMatch(r.all, /not found/, 'it looked for the bank relative to the cwd');
    assert.match(r.all, /handoff|cut handoff/i, `the fixture story was not listed:\n${r.all.slice(0, 300)}`);
  } finally { cleanup(f); }
});

test('jd-skill-gap reads cv.md from the data root, not the cwd', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.dataRoot, 'jds'), { recursive: true });
    writeFileSync(join(f.dataRoot, 'jds', 'acme.md'), [
      '# Senior Software Engineer',
      '',
      'Requirements: Python, retrieval pipelines and LLM evaluation.',
      '',
    ].join('\n'));
    const r = run('jd-skill-gap.mjs', [join(f.dataRoot, 'jds', 'acme.md'), '--json'], f);
    assert.equal(r.status, 0, `jd-skill-gap failed off the data root:\n${r.all.slice(0, 300)}`);
    assert.doesNotMatch(r.all, /cv\.md not found/, 'it looked for cv.md relative to the cwd');
    JSON.parse(r.stdout); // the documented --json surface
  } finally { cleanup(f); }
});

test('contacts --vcf writes under the data root when the data root is relocated', () => {
  const f = fixture();
  try {
    const out = join(f.dataRoot, 'output', 'contacts.vcf');
    const r = run('contacts.mjs', ['--vcf', out], f);
    assert.equal(r.status, 0, `the documented --vcf target was refused:\n${r.all.slice(0, 300)}`);
    assert.ok(existsSync(out), 'no vCard was written');
    assert.match(readFileSync(out, 'utf-8'), /BEGIN:VCARD/, 'the vCard is malformed');
  } finally { cleanup(f); }
});

test('doctor onboarding creates modes/ and copies every template into a fresh data root', () => {
  const f = fixture({ modes: false, storyBank: false, contacts: false });
  try {
    const r = run('doctor.mjs', ['--json'], f);
    const payload = JSON.parse(r.stdout);
    assert.ok(Array.isArray(payload.autoCopied), `doctor --json has no autoCopied list:\n${r.stdout.slice(0, 300)}`);
    for (const rel of ['modes/_profile.md', 'modes/_custom.md', 'modes/_brief.md', 'voice-dna.md']) {
      assert.ok(existsSync(join(f.dataRoot, ...rel.split('/'))), `${rel} was not copied into the fresh data root`);
      assert.ok(payload.autoCopied.includes(rel), `${rel} is missing from autoCopied (${JSON.stringify(payload.autoCopied)})`);
    }
  } finally { cleanup(f); }
});

test('a CRLF proof ledger does not leak carriage returns into --list json', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dataRoot, 'data', 'proof-points.tsv'), [
      'name\tstatus\turl\tblocks\tupdated',
      'eval-demo\tpublished\thttps://github.com/x/y\teval harness\t2026-01-01',
      '',
    ].join('\r\n'));
    const r = run('proof-point-bank.mjs', ['--list', 'json'], f);
    assert.equal(r.status, 0, `exited ${r.status}:\n${r.all.slice(0, 300)}`);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].updated, '2026-01-01', `a carriage return leaked into the field: ${JSON.stringify(rows[0].updated)}`);
    assert.equal(rows[0].name, 'eval-demo');

    // Same ledger, same reader contract, in the sibling that drafts from it.
    const p = run('proof-portfolio.mjs', ['--all', '--json'], f);
    assert.equal(p.status, 0, `proof-portfolio exited ${p.status}:\n${p.all.slice(0, 300)}`);
    const drafts = JSON.parse(p.stdout);
    assert.equal(drafts[0].name, 'eval-demo', `a carriage return leaked into the name: ${JSON.stringify(drafts[0].name)}`);
  } finally { cleanup(f); }
});

test('paste-reply writes the candidates file reply-watch reads', () => {
  // Writer and reader must resolve the same file: off the code root the append
  // landed where reply-watch never looked, and it then regenerated its own mocks
  // over it. A reverted run would write the checkout copy, so this test removes
  // whatever it finds there that did not exist before — it must not leave
  // user-layer state behind either way.
  const f = fixture();
  const strays = [join(ROOT, 'data', 'reply-candidates.json')];
  const before = strays.map((p) => existsSync(p));
  try {
    const reply = join(f.dataRoot, 'reply.txt');
    writeFileSync(reply, 'Subject: Interview\n\nThanks, we would like to schedule a call.\n');
    const r = run('paste-reply.mjs', ['--file', reply], f);
    assert.equal(r.status, 0, `paste-reply failed:\n${r.all.slice(0, 300)}`);
    const target = join(f.dataRoot, 'data', 'reply-candidates.json');
    assert.ok(existsSync(target), 'the candidates file was not written under the data root');
    assert.match(readFileSync(target, 'utf-8'), /Interview/, 'the pasted reply is not in the candidates file');
    strays.forEach((p, i) => assert.equal(existsSync(p), before[i], `paste-reply wrote the checkout copy at ${p}`));
  } finally {
    strays.forEach((p, i) => { if (!before[i]) rmSync(p, { force: true }); });
    cleanup(f);
  }
});

test('story-provenance-check reads its inputs from the data root, not the cwd', () => {
  const f = fixture();
  try {
    const r = run('story-provenance-check.mjs', ['--summary'], f);
    assert.doesNotMatch(r.all, /not found/i, `it looked for its inputs relative to the cwd:\n${r.all.slice(0, 300)}`);
    assert.match(r.all, /Claims checked/i, `no provenance summary was produced:\n${r.all.slice(0, 300)}`);
  } finally { cleanup(f); }
});

test('validate-portals resolves portals.yml under the data root', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dataRoot, 'portals.yml'), readFileSync(join(ROOT, 'templates', 'portals.example.yml'), 'utf-8'));
    const r = run('validate-portals.mjs', [], f);
    assert.equal(r.status, 0, `validate-portals failed off the data root:\n${r.all.slice(0, 400)}`);
    assert.doesNotMatch(r.all, /not found|No such file/i, `it looked for portals.yml relative to the cwd:\n${r.all.slice(0, 300)}`);
  } finally { cleanup(f); }
});
