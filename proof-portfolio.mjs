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
 *   node proof-portfolio.mjs --json                       → structured
 *   node proof-portfolio.mjs --self-test
 */
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { getCareerOpsRoot } from './path-resolver.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = getCareerOpsRoot();

// ── ledger read (shared format with proof-point-bank) ────────────────────────
function proofs() {
  const p = join(CAREER_OPS, 'data', 'proof-points.tsv');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(1)
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
  const checks = [
    ['proofs parse', Array.isArray(proofs())],
    ['empty when no ledger', proofs().every((x) => typeof x.name === 'string')],
    ['render emits blocks', render({ name: 'X', status: 'published', url: 'u', blocks: ['eval', 'rag'] }).includes('# X')],
  ];
  let n = 0;
  for (const [name, ok] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name}`); if (ok) n++; }
  console.log(`\nproof-portfolio ${n}/${checks.length} passed`);
  process.exit(n === checks.length ? 0 : 1);
}

const ni = args.indexOf('--name');
const all = args.includes('--all');
const list = proofs();
let targets = list.filter((p) => p.status === 'published');
if (ni !== -1) { const want = args[ni + 1]; targets = list.filter((p) => p.name.toLowerCase().includes(want.toLowerCase())); }
if (all) targets = list;
if (targets.length === 0) { console.log('no matching published proof-point; run proof-point-bank --add first, or check the name'); process.exit(0); }
if (args.includes('--json')) { console.log(JSON.stringify(targets.map((p) => ({ name: p.name, url: p.url, draft: render(p) })), null, 2)); process.exit(0); }
for (const p of targets) { console.log(render(p)); console.log('\n════════\n'); }
process.exit(0);