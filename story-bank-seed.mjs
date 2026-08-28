// @ts-check
/**
 * story-bank-seed.mjs — sweep every evaluation report's Block F into
 * interview-prep/story-bank.md, seeding the story bank the interview tools
 * depend on.
 *
 * match-star, negotiation-roi, and story-provenance-check all read
 * interview-prep/story-bank.md, but that file doesn't exist in this checkout —
 * so the interview suite has been dormant despite 42 evaluations each carrying
 * a full "## F) Interview Plan" STAR table. This script bridges them.
 *
 * It writes story-bank.md in the format match-star expects:
 *   ### [Theme] Title
 *   **Source:** …
 *   **S (Situation):** …  **T (Task):** …  **A (Action):** …  **R (Result):**
 *   **Reflection:** …
 * (Simplified: reports don't yet carry a per-story [Theme]; the `### Title`
 * form keeps parseStories working — the optional S/T/A/R labels it reads.)
 *
 * Usage:
 *   node story-bank-seed.mjs                    → write interview-prep/story-bank.md
 *   node story-bank-seed.mjs --preview          → print, don't write
 *   node story-bank-seed.mjs --json             → structured, no write
 *   node story-bank-seed.mjs --self-test
 *
 * It never touches the tracker and only writes the story-bank.
 */
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { getCareerOpsRoot } from './path-resolver.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = getCareerOpsRoot();
const REPORTS = join(CAREER_OPS, 'reports');
const BANK = join(__dir, 'interview-prep', 'story-bank.md');

// ── Block F row extraction ───────────────────────────────────────────────────
function rowsOf(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const p = line.split('|').map((s) => s.trim());
    // ["", num, jdReq, title, S, T, A, R, Reflection] (trailing "|" → 10 parts)
    const [, , jdReq, title, S, T, A, R, refl] = p;
    if (!title || !S || !T || !A || !R) continue;
    out.push({ jdReq: jdReq ?? '', title, s: S, t: T, a: A, r: R, reflection: refl ?? '' });
  }
  return out;
}

// ── catalog of all reports ──────────────────────────────────────────────────
function catalogFiles() {
  return existsSync(REPORTS) ? readdirSync(REPORTS).filter((f) => /^\d{3}-.+\.md$/.test(f)).sort() : [];
}

// ── gather + dedupe by title (keep first, count) ────────────────────────────
function gather(verbose = false) {
  const seen = new Map();
  for (const file of catalogFiles()) {
    const section = extractBlockF(readFileSync(join(REPORTS, file), 'utf8'));
    if (!section) continue;
    for (const st of rowsOf(section)) {
      const key = st.title.toLowerCase();
      const rec = seen.get(key);
      if (rec) rec.count++;
      else seen.set(key, { source: file, count: 1, story: st });
    }
  }
  return [...seen.values()].sort((a, b) => b.count - a.count);
}
function extractBlockF(text) {
  const m = text.match(/## F\)?[^\n]*Interview Plan[\s\S]*?(?=\n## |\n# |$)/);
  return m ? m[0] : null;
}

// Derive a theme + search tags per story from its title + JD requirement + S/T/A
// text, so the seeded bank plays well with match-star's tag-based matching.
function themeFor(story) {
  const hay = `${story.title} ${story.jdReq ?? ''}`.toLowerCase();
  if (/agent|workflow|automation|orchestrat/.test(hay)) return 'Agents & Automation';
  if (/rag|retriev|vector|embedding|chunk/.test(hay)) return 'Retrieval & RAG';
  if (/eval|llm|model|inference/.test(hay)) return 'LLM & Evaluation';
  if (/architect|platform|delivery|enterprise/.test(hay)) return 'Enterprise Architecture';
  if (/adopt|enable|influence|leadership|team/.test(hay)) return 'Adoption & Influence';
  if (/guardrail|security|compliance|governance|data/.test(hay)) return 'Safety & Guardrails';
  if (/ui|interface|streamlit|gradio|demo/.test(hay)) return 'AI UX & Prototyping';
  return 'General';
}

function tagsFor(story) {
  const hay = `${story.title} ${story.jdReq ?? ''} ${story.s} ${story.t} ${story.a} ${story.r}`.toLowerCase();
  const tags = new Set();
  const map = {
    agent: 'agents', workflow: 'agents', orchestration: 'agents',
    rag: 'rag', retrieval: 'rag', embedding: 'rag', vector: 'rag',
    llm: 'llm', model: 'llm', eval: 'evaluation', evaluation: 'evaluation',
    langchain: 'langchain', crewai: 'crewai', autogen: 'autogen',
    enterprise: 'enterprise', consulting: 'consulting', architecture: 'architecture',
    sql: 'sql-server', '.net': '.net', 'c#': 'c#', database: 'sql-server', perf: 'performance',
    adoption: 'adoption', influence: 'influence', leadership: 'leadership',
    guardrail: 'guardrails', security: 'security', compliance: 'compliance',
    streamlit: 'streamlit', gradio: 'gradio', demo: 'demo',
  };
  for (const [k, v] of Object.entries(map)) if (hay.includes(k)) tags.add(v);
  if (tags.size === 0) tags.add('general');
  return [...tags];
}

function render(items) {
  const parts = [
    '# Story Bank',
    '',
    'Accumulated STAR+ reflection stories from evaluation reports. Each line',
    'shows how many reports the story appeared in; keep the 5-10 that recur.',
    'Edit freely — this is user layer.',
    '',
  ];
  for (const it of items) {
    const theme = themeFor(it.story);
    const tags = tagsFor(it.story);
    parts.push(`### [${theme}] ${it.story.title}`);
    parts.push('');
    parts.push(`**Source:** from ${it.source} (${it.count}×)`);
    parts.push(`**Best for questions about:** ${tags.join(', ')}`);
    parts.push(`**S (Situation):** ${it.story.s}`);
    parts.push(`**T (Task):** ${it.story.t}`);
    parts.push(`**A (Action):** ${it.story.a}`);
    parts.push(`**R (Result):** ${it.story.r}`);
    parts.push(`**Reflection:** ${it.story.reflection}`);
    parts.push('');
    parts.push('');
  }
  return parts.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  const fake = `## F 2) Interview Plan
| # | JD | STAR | S | T | A | R | Reflection |
|---|----|------|---|---|---|---|-----------|
| 1 | x | CrewAI agents | build multi-tool | coordinate | composed | worked | orchestration |
| 2 | y | RAG pipeline | silo doc | retrieve | benchmarked | Q&A | retrieval matters |
`;
  const r = rowsOf(fake);
  const checks = [
    ['parses 2 rows', r.length === 2],
    ['title', r[0].title === 'CrewAI agents'],
    ['reflection', r[0].reflection === 'orchestration'],
    ['field s', r[1].s === 'silo doc'],
    ['skips 3-col lines', rowsOf('| 1 | x | y |').length === 0],
    ['theme derivation', themeFor(r[0]) === 'Agents & Automation' && themeFor(r[1]) === 'Retrieval & RAG'],
    ['tag derivation', tagsFor(r[0]).includes('agents') && tagsFor(r[1]).includes('rag')],
  ];
  let n = 0;
  for (const [name, ok] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name}`); if (ok) n++; }
  console.log(`\nstory-bank-seed ${n}/${checks.length} passed`);
  process.exit(n === checks.length ? 0 : 1);
}

const items = gather();
if (args.includes('--json')) { console.log(JSON.stringify(items, null, 2)); process.exit(0); }
if (args.includes('--preview')) { console.log(render(items).slice(0, 1600)); process.exit(0); }
if (items.length === 0) { console.log('no Block F STAR rows found in reports/*.md'); process.exit(0); }

if (!args.includes('--no-write')) {
  try { mkdirSync(dirname(BANK), { recursive: true }); writeFileSync(BANK, render(items)); }
  catch { console.error('write failed'); process.exit(4); }
}
console.log(`story-bank: ${items.length} unique, recurring titles → ${BANK}`);
for (const it of items.slice(0, 8)) console.log(`  ×${it.count}  ${it.story.title}`);
process.exit(0);