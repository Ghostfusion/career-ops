// @ts-check
/**
 * proof-portfolio.mjs — turn a published proof-point into a hiring-ready
 * "case study" draft (README-style one-pager) sourced only from your own
 * cv.md / proof-points.tsv / report. Nothing is fabricated: every claim maps
 * to a line in user-layer files.
 *
 * It does NOT write to your portfolio repo (you publish). It prints a draft
 * you can paste into a GitHub README / project blurb / portfolio.
 *
 * Usage:
 *   node proof-portfolio.mjs --proof "RAG eval harness"   → draft that one
 *   node proof-portfolio.mjs --all                        → draft every published
 *   node proof-portfolio.mjs --json                       → structured (always JSON; [] when nothing matches)
 *   node proof-portfolio.mjs --self-test
 *
 * `--name` is accepted as an alias of `--proof`.
 * Exit codes: 0 ok · 1 usage.
 */
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { getCareerOpsRoot } from './path-resolver.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = getCareerOpsRoot();

// ── ledger read (shared format with proof-point-bank) ────────────────────────
// `file` is injectable so the self-test can drive this against a literal
// ledger instead of only asserting shapes that hold for any input.
function proofs(file = join(CAREER_OPS, 'data', 'proof-points.tsv')) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(1)
    .map((l) => l.split('\t'))
    .filter((r) => r[0] && !r[0].startsWith('name'))
    .map((r) => ({ name: r[0], status: r[1] || '', url: r[2] || '', blocks: (r[3] || '').split('|').filter(Boolean) }));
}

// pull a supporting sentence from cv.md for the "why it matters" line
function cvLine(pin) {
  try {
    const t = readFileSync(join(CAREER_OPS, 'cv.md'), 'utf8');
    for (const line of t.split('\n')) if (new RegExp(pin, 'i').test(line) && line.trim()) return line.trim();
  } catch {}
  return '';
}
function cvSummary() {
  try {
    const t = readFileSync(join(CAREER_OPS, 'cv.md'), 'utf8');
    const m = t.match(/# Professional Summary[\s\S]*?(?=## )/);
    return m ? m[0].replace(/#[^\n]*/g, '').trim() : '';
  } catch { return ''; }
}

function render(proof) {
  const lines = [];
  lines.push(`# ${proof.name}`);
  lines.push('');
  lines.push(proof.url ? `> ${proof.url}` : '> (add your URL when you publish it)');
  lines.push('');
  lines.push('## Problem');
  lines.push((proof.blocks[0] ? `${proof.blocks.join(', ')} — the gap this addresses.` : cxProse(cvSummary())));
  lines.push('');
  lines.push('## What I built');
  lines.push(`A focused ${proof.blocks.join(' / ')} project. ${cvLine(proof.blocks[0] || proof.name) || 'Built hands-on.'}`);
  lines.push('');
  lines.push('## Why it matters');
  lines.push(`This is the kind of artifact the ${proof.status === 'published' ? 'published' : 'in-progress'} work lives on.`);
  lines.push('');
  lines.push('## Try it');
  lines.push(`Run it and see — ${proof.url || 'link to be added'}.`);
  lines.push('');
  return lines.join('\n');
}
const cxProse = (s) => s || '';

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  // Drive proofs()/render() against a literal ledger written here. The old
  // checks (Array.isArray, typeof name, `# ${name}`) held for every possible
  // input, so a broken parser or renderer still passed.
  const FIXTURE = [
    'name\tstatus\turl\tblocks\tupdated',
    'RAG Eval Harness\tpublished\thttps://github.com/me/rag\teval|rag\t2026-01-01',
    '',
  ].join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-proofportfolio-selftest-'));
  try {
    const fixturePath = join(dir, 'proof-points.tsv');
    writeFileSync(fixturePath, FIXTURE);
    const parsed = proofs(fixturePath);
    const first = parsed[0];
    const draft = first ? render(first) : '';
    const checks = [
      ['parses one ledger row', parsed.length === 1],
      ['maps name/status/blocks',
        first?.name === 'RAG Eval Harness' && first?.status === 'published' && first?.blocks.join('|') === 'eval|rag'],
      ['renders parsed name/url/status',
        draft.includes('# RAG Eval Harness') && draft.includes('> https://github.com/me/rag') && draft.includes('published')],
    ];
    let n = 0;
    for (const [name, ok] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name}`); if (ok) n++; }
    console.log(`\nproof-portfolio ${n}/${checks.length} passed`);
    process.exit(n === checks.length ? 0 : 1);
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

const ni = args.includes('--proof') ? args.indexOf('--proof') : args.indexOf('--name');
const all = args.includes('--all');
const asJson = args.includes('--json');
const list = proofs();
let targets = list.filter((p) => p.status === 'published');
if (ni !== -1) {
  const want = args[ni + 1];
  if (!want || want.startsWith('-')) { console.error('Usage: node proof-portfolio.mjs --proof "<name>"'); process.exit(1); }
  targets = list.filter((p) => p.name.toLowerCase().includes(want.toLowerCase()));
}
if (all) targets = list;
if (targets.length === 0) {
  // `--json` always emits JSON, including for an empty result set; the prose
  // line is for humans only.
  if (asJson) { console.log('[]'); process.exit(0); }
  console.log('no matching published proof-point; run proof-point-bank --add first, or check the name');
  process.exit(0);
}
if (asJson) { console.log(JSON.stringify(targets.map((p) => ({ name: p.name, url: p.url, draft: render(p) })), null, 2)); process.exit(0); }
for (const p of targets) { console.log(render(p)); console.log('\n════════\n'); }
process.exit(0);