// tests/proof-portfolio.test.mjs — proof-portfolio drafts a case study from the
// proof-point ledger and cv.md. It must select targets by status/name, emit the
// documented JSON shape, keep its per-section prose sourced from user files,
// and never write anything. Its --self-test must drive the real reader and
// renderer against a literal ledger (so a broken parse fails it), which the
// last test proves by running a deliberately regressed copy.
//
// Run:  node --test tests/proof-portfolio.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const LEDGER_HEADER = 'name\tstatus\turl\tblocks\tupdated\n';

function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-proofportfolio-'));
  const decoyCwd = mkdtempSync(join(tmpdir(), 'career-ops-proofportfoliocwd-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  writeFileSync(join(dataRoot, 'data', 'proof-points.tsv'), [
    LEDGER_HEADER.trimEnd(),
    'RAG Eval Harness\tpublished\thttps://github.com/me/rag\teval|rag\t2026-01-01',
    'Secret Project\tbuilding\t\tstealth\t2026-01-02',
    '',
  ].join('\n'));
  writeFileSync(join(dataRoot, 'cv.md'), [
    '# Professional Summary',
    'Built evaluation harnesses for ML systems.',
    '',
    '## Experience',
    '- n',
    '',
  ].join('\n'));
  return { dataRoot, decoyCwd };
}

function bareFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-proofportfolio-'));
  const decoyCwd = mkdtempSync(join(tmpdir(), 'career-ops-proofportfoliocwd-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  return { dataRoot, decoyCwd };
}

function run(args, { dataRoot, decoyCwd }) {
  const r = spawnSync(process.execPath, [join(ROOT, 'proof-portfolio.mjs'), ...args], {
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

test('proof-portfolio --self-test passes', () => {
  const f = fixture();
  try {
    const r = run(['--self-test'], f);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.all.slice(0, 300)}`);
    assert.match(r.stdout, /proof-portfolio 3\/3 passed/);
  } finally { cleanup(f); }
});

test('--json drafts only published proofs, with URL and the documented sections', () => {
  const f = fixture();
  try {
    const r = run(['--json'], f);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.all.slice(0, 300)}`);
    const drafts = JSON.parse(r.stdout);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].name, 'RAG Eval Harness');
    assert.equal(drafts[0].url, 'https://github.com/me/rag');
    assert.match(drafts[0].draft, /^# RAG Eval Harness/m);
    assert.match(drafts[0].draft, /> https:\/\/github\.com\/me\/rag/);
    for (const section of ['## Problem', '## What I built', '## Why it matters', '## Try it']) {
      assert.match(drafts[0].draft, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    // The "What I built" line is pulled from cv.md, not fabricated.
    assert.match(drafts[0].draft, /Built evaluation harnesses for ML systems\./);
  } finally { cleanup(f); }
});

test('--all includes unpublished proofs and marks them in-progress', () => {
  const f = fixture();
  try {
    const r = run(['--all', '--json'], f);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.all.slice(0, 300)}`);
    const drafts = JSON.parse(r.stdout);
    assert.deepEqual(drafts.map((d) => d.name), ['RAG Eval Harness', 'Secret Project']);
    const secret = drafts.find((d) => d.name === 'Secret Project');
    assert.match(secret.draft, /in-progress work lives on/);
  } finally { cleanup(f); }
});

test('--name selects a proof case-insensitively', () => {
  const f = fixture();
  try {
    const r = run(['--name', 'secret', '--json'], f);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.all.slice(0, 300)}`);
    const drafts = JSON.parse(r.stdout);
    assert.deepEqual(drafts.map((d) => d.name), ['Secret Project']);
  } finally { cleanup(f); }
});

test('no matching proof is an empty success, not a crash', () => {
  const f = fixture();
  try {
    const r = run(['--name', 'nonexistent'], f);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.all.slice(0, 300)}`);
    assert.match(r.stdout, /no matching published proof-point/);
  } finally { cleanup(f); }
});

test('a missing ledger drafts nothing and exits 0', () => {
  const f = bareFixture();
  try {
    const r = run(['--all'], f);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.all.slice(0, 300)}`);
    assert.match(r.stdout, /no matching published proof-point/);
  } finally { cleanup(f); }
});

test('--proof is the documented selector, and --name is still its alias', () => {
  const f = fixture();
  try {
    const byProof = run(['--proof', 'RAG', '--json'], f);
    assert.equal(byProof.status, 0, `exited ${byProof.status}: ${byProof.all.slice(0, 300)}`);
    assert.deepEqual(JSON.parse(byProof.stdout).map((d) => d.name), ['RAG Eval Harness']);

    const alias = run(['--name', 'RAG', '--json'], f);
    assert.equal(alias.status, 0, `exited ${alias.status}: ${alias.all.slice(0, 300)}`);
    assert.deepEqual(JSON.parse(alias.stdout).map((d) => d.name), ['RAG Eval Harness']);

    const bare = run(['--proof'], f);
    assert.equal(bare.status, 1, `a bare --proof is a usage error:\n${bare.all.slice(0, 300)}`);
    assert.match(bare.all, /Usage: node proof-portfolio\.mjs --proof/);
  } finally { cleanup(f); }
});

test('--json stays JSON — an empty result set is [], not prose', () => {
  const f = fixture();
  try {
    const r = run(['--proof', 'nonexistent', '--json'], f);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.all.slice(0, 300)}`);
    assert.deepEqual(JSON.parse(r.stdout), [], `expected [] from --json:\n${r.stdout.slice(0, 200)}`);
  } finally { cleanup(f); }
});

test('text mode prints one rendered draft per target', () => {
  const f = fixture();
  try {
    const r = run(['--all'], f);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.all.slice(0, 300)}`);
    assert.equal((r.stdout.match(/^# RAG Eval Harness$/gm) || []).length, 1);
    assert.equal((r.stdout.match(/^# Secret Project$/gm) || []).length, 1);
  } finally { cleanup(f); }
});

test('proof-portfolio never writes the ledger or the cwd', () => {
  const f = fixture();
  try {
    const ledger = join(f.dataRoot, 'data', 'proof-points.tsv');
    const before = readFileSync(ledger, 'utf-8');
    run(['--all'], f);
    assert.equal(readFileSync(ledger, 'utf-8'), before, 'proof-portfolio rewrote the ledger');
    assert.deepEqual(readdirSync(f.decoyCwd), [], 'proof-portfolio wrote into the directory it was launched from');
  } finally { cleanup(f); }
});

test('--self-test fails when the ledger parse regresses', () => {
  // The self-test must fail on a real regression, not on shapes that hold for
  // any input. Break the blocks parse in a sandboxed copy and require exit 1.
  // If proofs() is ever refactored, this replace silently becomes a no-op and
  // the run passes 3/3 — the assertion below then fails, so update the pattern.
  const codeRoot = mkdtempSync(join(tmpdir(), 'career-ops-proofportfolio-code-'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-proofportfolio-'));
  const decoyCwd = mkdtempSync(join(tmpdir(), 'career-ops-proofportfolio-cwd-'));
  try {
    const src = readFileSync(join(ROOT, 'proof-portfolio.mjs'), 'utf-8');
    const mutated = src.replace("blocks: (r[3] || '').split('|').filter(Boolean)", 'blocks: []');
    writeFileSync(join(codeRoot, 'proof-portfolio.mjs'), mutated);
    copyFileSync(join(ROOT, 'path-resolver.mjs'), join(codeRoot, 'path-resolver.mjs'));
    const r = spawnSync(process.execPath, [join(codeRoot, 'proof-portfolio.mjs'), '--self-test'], {
      cwd: decoyCwd,
      encoding: 'utf-8',
      timeout: 60_000,
      env: { ...process.env, CAREER_OPS_ROOT: dataRoot, CAREER_OPS_DATA_DIR: '' },
    });
    assert.equal(r.status, 1, `a regressed parse must fail the self-test:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /proof-portfolio 2\/3 passed/, `the failing check must be reported:\n${r.stdout}`);
  } finally {
    cleanup({ dataRoot, decoyCwd });
    rmSync(codeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
