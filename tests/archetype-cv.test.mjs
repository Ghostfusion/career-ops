// tests/archetype-cv.test.mjs — archetype-cv.mjs, the calibrated sample of what
// a tailored CV looks like per target archetype.
//
// Two inputs, two roots: the CV is the user's (cv.md under the data root) and
// the archetype list is config/profile.yml. The script reads profile.yml
// relative to ITS OWN directory rather than the data root, so a fixture dropped
// in the data root alone would be silently ignored and this suite would be
// reading the checkout's real profile. Each case therefore runs a byte-copy of
// the script (plus its path-resolver dependency) from a temp code root that
// carries the fixture profile — hermetic, and still red on any regression in
// the script's own bytes. The fixture is also written into the data root, so a
// fix that honours the data root keeps this suite green.
//
// Run:  node --test tests/archetype-cv.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const CV_TOKEN = 'TQ7F3A-CV-SUMMARY-TOKEN';
const CV_MD = [
  '# Vincent Liu',
  '',
  '## Professional Summary',
  '',
  `${CV_TOKEN} ships enterprise AI systems.`,
  '',
  '## Skills',
  '',
  '- LLM engineering',
  '',
].join('\n');

const ARCHETYPES = [
  'Generative AI / LLM Engineer',
  'AI Solutions Architect',
  '.NET / Solutions Architect',
  'AI Product Manager',
];

const PROFILE_YML = [
  '# fixture profile — archetypes only',
  'archetypes:',
  ...ARCHETYPES.flatMap((name) => [`  - name: "${name}"`, '    level: senior']),
  '',
].join('\n');

function fixture({ withProfile = true, profile = PROFILE_YML } = {}) {
  const codeRoot = mkdtempSync(join(tmpdir(), 'career-ops-archetypecv-code-'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-archetypecv-'));
  const decoyCwd = mkdtempSync(join(tmpdir(), 'career-ops-archetypecv-cwd-'));
  // The script resolves './path-resolver.mjs' relative to itself; the copy
  // needs it standalone.
  copyFileSync(join(ROOT, 'archetype-cv.mjs'), join(codeRoot, 'archetype-cv.mjs'));
  copyFileSync(join(ROOT, 'path-resolver.mjs'), join(codeRoot, 'path-resolver.mjs'));
  writeFileSync(join(dataRoot, 'cv.md'), CV_MD);
  if (withProfile) {
    mkdirSync(join(codeRoot, 'config'), { recursive: true });
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    writeFileSync(join(codeRoot, 'config', 'profile.yml'), profile);
    writeFileSync(join(dataRoot, 'config', 'profile.yml'), profile);
  }
  return { codeRoot, dataRoot, decoyCwd };
}

function run(args, { codeRoot, dataRoot, decoyCwd }) {
  const r = spawnSync(process.execPath, [join(codeRoot, 'archetype-cv.mjs'), ...args], {
    cwd: decoyCwd,
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, CAREER_OPS_ROOT: dataRoot, CAREER_OPS_DATA_DIR: '' },
  });
  assert.equal(r.error, undefined, `spawn failed: ${r.error?.message}`);
  return { ...r, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const cleanup = (f) => {
  for (const d of [f.codeRoot, f.dataRoot, f.decoyCwd]) {
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
};

test('--self-test reports its own verdict', () => {
  const f = fixture();
  try {
    const r = run(['--self-test'], f);
    assert.equal(r.status, 0, `self-test exited ${r.status}:\n${r.all}`);
    assert.match(r.all, /archetype-cv 3\/3 passed/);
  } finally { cleanup(f); }
});

test('--json lists exactly the archetypes from the configured profile, in file order', () => {
  const f = fixture();
  try {
    const r = run(['--json'], f);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.all}`);
    assert.deepEqual(JSON.parse(r.stdout), ARCHETYPES);
  } finally { cleanup(f); }
});

test('--archetype filters case-insensitively', () => {
  const f = fixture();
  try {
    const r = run(['--archetype', '.net', '--json'], f);
    assert.deepEqual(JSON.parse(r.stdout), ['.NET / Solutions Architect']);
    const ai = run(['--archetype', 'ai', '--json'], f);
    assert.deepEqual(JSON.parse(ai.stdout), [
      'Generative AI / LLM Engineer',
      'AI Solutions Architect',
      'AI Product Manager',
    ]);
  } finally { cleanup(f); }
});

test('the rendered sample leads with the archetype headline and the CV summary from the data root', () => {
  const f = fixture();
  try {
    const r = run([], f);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.all}`);
    assert.match(r.stdout, /^### Generative AI \/ LLM Engineer$/m);
    assert.match(r.stdout, /headline: Generative AI Engineer — LLMs, agents, RAG, evaluation/);
    assert.match(r.stdout, /skills surfaced first:  LLM, LangChain/);
    assert.match(r.stdout, new RegExp(CV_TOKEN), 'the sample did not quote the CV it was told to read');
  } finally { cleanup(f); }
});

test('a filter that matches nothing is an empty result, not an error', () => {
  const f = fixture();
  try {
    const r = run(['--archetype', 'zzz-nothing'], f);
    assert.equal(r.status, 0, `exited ${r.status}: ${r.all}`);
    assert.match(r.stdout, /no archetypes matched/);
    const json = run(['--archetype', 'zzz-nothing', '--json'], f);
    assert.deepEqual(JSON.parse(json.stdout), []);
  } finally { cleanup(f); }
});

test('no profile.yml means no archetypes — and the self-test says so', () => {
  const f = fixture({ withProfile: false });
  try {
    const list = run(['--json'], f);
    assert.equal(list.status, 0, `exited ${list.status}: ${list.all}`);
    assert.deepEqual(JSON.parse(list.stdout), []);
    const st = run(['--self-test'], f);
    assert.equal(st.status, 1, `a missing profile must not pass the self-test: ${st.all}`);
    assert.match(st.all, /archetype-cv 2\/3 passed/);
    assert.match(st.all, /reads archetypes/);
  } finally { cleanup(f); }
});

test('--self-test fails when the profile advertises an archetype with no calibrated sample', () => {
  // The check used to count the keys of a hard-coded literal, so a profile with
  // an uncalibrated archetype still reported 3/3 while the sample for that
  // archetype rendered no headline and no skills.
  const profile = [
    'archetypes:',
    ...ARCHETYPES.flatMap((name) => [`  - name: "${name}"`, '    level: senior']),
    '  - name: "Quantum Prompt Whisperer"',
    '    level: senior',
    '',
  ].join('\n');
  const f = fixture({ profile });
  try {
    const st = run(['--self-test'], f);
    assert.equal(st.status, 1, `an uncalibrated archetype must not pass the self-test:\n${st.all}`);
    assert.match(st.all, /archetype-cv 2\/3 passed/);
    assert.match(st.all, /❌ archetypes have skills/);
  } finally { cleanup(f); }
});

test('it never writes — data root and launch cwd come back untouched', () => {
  const f = fixture();
  try {
    const before = readFileSync(join(f.dataRoot, 'cv.md'));
    run([], f);
    run(['--json'], f);
    assert.deepEqual(readFileSync(join(f.dataRoot, 'cv.md')), before);
    assert.deepEqual(readdirSync(f.decoyCwd), [], 'a script wrote into the directory it was launched from');
  } finally { cleanup(f); }
});
