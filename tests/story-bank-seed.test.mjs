// tests/story-bank-seed.test.mjs — story-bank-seed.mjs sweeps the `## F)
// Interview Plan` STAR tables out of the data-root reports/*.md and renders the
// match-star story bank the interview tools read.
//
// Every case runs the child with CAREER_OPS_ROOT at a fixture and the cwd at a
// DIFFERENT decoy directory, so a report path following the cwd (or the
// checkout) finds nothing while one following the data root finds the fixture.
// The write cases run against the fixture root only, and the checkout's own
// interview-prep/story-bank.md is hashed before and after to prove it: a
// default run into an EMPTY root seeds the bank, and a default run into a root
// that already has one refuses (exit 3) unless --force is passed.
//
// Run:  node --test tests/story-bank-seed.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = 'story-bank-seed.mjs';

const F_HEADER = [
  '## F) Interview Plan',
  '| # | JD | STAR | S | T | A | R | Reflection |',
  '|---|----|------|---|---|---|---|-----------|',
];

function report(title, rows) {
  return [`# ${title}`, '', ...F_HEADER, ...rows, ''].join('\n');
}

function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-story-bank-'));
  const decoyCwd = mkdtempSync(join(tmpdir(), 'career-ops-story-bank-cwd-'));
  const reports = join(dataRoot, 'reports');
  mkdirSync(reports, { recursive: true });
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  writeFileSync(join(dataRoot, 'data', 'applications.md'), [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|---|---|---|---|---|---|---|---|',
    '| 1 | 2026-01-05 | Acme | Backend Engineer | 4.2/5 | Applied | \u2705 | [1](r1.md) | n |',
    '',
  ].join('\n'));
  writeFileSync(join(reports, '001-acme.md'), report('001 — Acme', [
    '| 1 | Agent orchestration | CrewAI agents | build multi-tool | coordinate | composed | worked | orchestration |',
    '| 2 | Retrieval platform | RAG pipeline | silo doc | retrieve | benchmarked | Q&A | retrieval matters |',
  ]));
  // Recurring title: same story in a second report, first occurrence must win.
  writeFileSync(join(reports, '002-globex.md'), report('002 — Globex', [
    '| 1 | Workflow automation | CrewAI agents | wire tools | sequence | shipped | cut time | scale |',
  ]));
  // Numeric rows outside any Block F section must not be swept in.
  writeFileSync(join(reports, '003-initech.md'), [
    '# 003 — Initech', '', '## A) Role Fit', '',
    '| 1 | x | Should Not Appear | a | b | c | d | e |', '',
  ].join('\n'));
  // A non-report filename is not part of the catalog even when it carries Block F.
  writeFileSync(join(reports, 'notes.md'), report('notes', [
    '| 1 | x | Should Not Appear | a | b | c | d | e |',
  ]));
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

const bankPathOf = (f) => join(f.dataRoot, 'interview-prep', 'story-bank.md');
// The checkout's own bank is USER layer: no case here may write it.
const CHECKOUT_BANK = join(ROOT, 'interview-prep', 'story-bank.md');
const sha = (p) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : null);

test('a fresh data root is seeded by default', () => {
  const f = fixture();
  const before = sha(CHECKOUT_BANK);
  try {
    const r = run([], f);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /story-bank: 2 unique, recurring titles/);
    assert.match(readFileSync(bankPathOf(f), 'utf8'), /### \[Agents & Automation\] CrewAI agents/, 'the default run must still seed an empty root');
    assert.equal(sha(CHECKOUT_BANK), before, 'a fixture-root run wrote the checkout story bank');
  } finally { cleanup(f); }
});

test('an existing bank is left alone unless --force, and --force overwrites it', () => {
  // The rendered bank invites curation ("Edit freely — this is user layer"), so
  // a default re-run used to destroy those edits silently. It must refuse.
  const f = fixture();
  const curated = '# Story Bank\n\nMy curated story — handwritten, not regenerable.\n';
  const before = sha(CHECKOUT_BANK);
  try {
    mkdirSync(join(f.dataRoot, 'interview-prep'), { recursive: true });
    writeFileSync(bankPathOf(f), curated);

    const refused = run([], f);
    assert.equal(refused.status, 3, `expected the documented refusal exit:\n${refused.all.slice(0, 400)}`);
    assert.match(refused.all, /already exists — refusing to overwrite/, `the refusal must say why:\n${refused.all.slice(0, 400)}`);
    assert.match(refused.all, /--preview/, 'the refusal must offer --preview');
    assert.match(refused.all, /--force/, 'the refusal must offer --force');
    assert.equal(readFileSync(bankPathOf(f), 'utf8'), curated, 'the default run destroyed a curated bank');

    const forced = run(['--force'], f);
    assert.equal(forced.status, 0, forced.all);
    assert.match(forced.stdout, /story-bank: 2 unique, recurring titles/);
    assert.match(readFileSync(bankPathOf(f), 'utf8'), /### \[Agents & Automation\] CrewAI agents/, '--force must overwrite the bank with the seed');
    assert.equal(sha(CHECKOUT_BANK), before, 'a fixture-root run wrote the checkout story bank');
  } finally { cleanup(f); }
});

test('--self-test exits 0 with its own 7/7 verdict', () => {
  const f = fixture();
  try {
    const r = run(['--self-test'], f);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /story-bank-seed 7\/7 passed/);
  } finally { cleanup(f); }
});

test('--json gathers unique Block F titles from the data-root reports, keeping the first occurrence', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.decoyCwd, 'reports'), { recursive: true });
    writeFileSync(join(f.decoyCwd, 'reports', '001-decoy.md'), report('decoy', [
      '| 1 | x | Decoy Story | a | b | c | d | e |',
    ]));

    const r = run(['--json'], f);
    assert.equal(r.status, 0, r.all);
    const items = JSON.parse(r.stdout);

    assert.equal(items.length, 2, `expected CrewAI agents + RAG pipeline only:\n${r.stdout}`);
    assert.equal(items[0].story.title, 'CrewAI agents');
    assert.equal(items[0].count, 2, 'the recurring title must be counted, not duplicated');
    assert.equal(items[0].source, '001-acme.md', 'the first occurrence wins');
    assert.equal(items[0].story.s, 'build multi-tool', 'the first occurrence\'s STAR fields win');
    assert.equal(items[0].story.reflection, 'orchestration');

    const rag = items.find((it) => it.story.title === 'RAG pipeline');
    assert.ok(rag, `RAG pipeline missing:\n${r.stdout}`);
    assert.equal(rag.count, 1);
    assert.equal(rag.story.title, 'RAG pipeline');

    assert.ok(items[0].count >= items[1].count, 'items must be sorted by recurrence');
    assert.doesNotMatch(r.stdout, /Should Not Appear/, 'rows outside Block F or outside the report catalog leaked in');
    assert.doesNotMatch(r.stdout, /Decoy Story/, 'it read the cwd\'s reports directory, not the data root');
  } finally { cleanup(f); }
});

test('--preview renders the match-star bank format without writing', () => {
  const f = fixture();
  try {
    const r = run(['--preview'], f);
    assert.equal(r.status, 0, r.all);
    const out = r.stdout;

    assert.ok(out.includes('### [Agents & Automation] CrewAI agents'), `theme heading missing:\n${out}`);
    assert.ok(out.includes('**Source:** from 001-acme.md (2\u00d7)'), `source/count line missing:\n${out}`);
    assert.ok(out.includes('**S (Situation):** build multi-tool'), 'S label missing');
    assert.ok(out.includes('**T (Task):** coordinate'), 'T label missing');
    assert.ok(out.includes('**A (Action):** composed'), 'A label missing');
    assert.ok(out.includes('**R (Result):** worked'), 'R label missing');
    assert.ok(out.includes('**Reflection:** orchestration'), 'Reflection label missing');
    assert.ok(out.includes('### [Retrieval & RAG] RAG pipeline'), 'second story missing');
    assert.doesNotMatch(out, /Should Not Appear/, 'rows outside Block F or the catalog leaked into the render');
    assert.deepEqual(readdirSync(f.decoyCwd), [], 'a script wrote into the directory it was launched from');
  } finally { cleanup(f); }
});

test('reports with no Block F are the documented no-op', () => {
  const f = fixture();
  try {
    rmSync(join(f.dataRoot, 'reports'), { recursive: true, force: true });
    mkdirSync(join(f.dataRoot, 'reports'), { recursive: true });
    writeFileSync(join(f.dataRoot, 'reports', '001-acme.md'), '# 001 — Acme\n\n## A) Role Fit\nno star rows\n');
    const r = run(['--no-write'], f);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /no Block F STAR rows found in reports\/\*\.md/);
  } finally { cleanup(f); }
});

test('never writes the tracker', () => {
  const f = fixture();
  try {
    const before = readFileSync(join(f.dataRoot, 'data', 'applications.md'), 'utf8');
    const r = run(['--no-write'], f);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /story-bank: 2 unique, recurring titles/);
    assert.equal(
      readFileSync(join(f.dataRoot, 'data', 'applications.md'), 'utf8'),
      before,
      'story-bank-seed must only write the story bank',
    );
  } finally { cleanup(f); }
});
