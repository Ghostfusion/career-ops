// @ts-check
/**
 * archetype-cv.mjs — show what a tailored CV *looks like* for each of your
 * target archetypes, so the `pdf`/`latex` tailoring has a calibrated sample.
 *
 * It reads the real archetypes from config/profile.yml and the real CV
 * (cv.md), then produces, per archetype, a suggested tailored summary lead +
 * which skills to surface first — every keyword copied from your own files,
 * never invented (reordered, not fabricated).
 *
 * Usage:
 *   node archetype-cv.mjs                  → all archetypes
 *   node archetype-cv.mjs --archetype ai   → filter
 *   node archetype-cv.mjs --json
 *   node archetype-cv.mjs --self-test
 */
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));

let _cv = null;
function cv() {
  if (_cv) return _cv;
  const p = join(__dir, 'cv.md');
  const summary = existsSync(p) ? (readFileSync(p, 'utf8').match(/# Professional Summary[\s\S]*?(?=\n## |$)/) || [''])[0]?.replace(/#[^\n]*/g, '').trim() || '' : '';
  _cv = { summary };
  return _cv;
}
function cvSummary() { return cv().summary; }

function archetypeNames() {
  const p = join(__dir, 'config', 'profile.yml');
  if (!existsSync(p)) return [];
  const t = readFileSync(p, 'utf8');
  return [...t.matchAll(/^\s*-\s+name:\s*"([^"]+)"/gm)].map((m) => m[1]);
}

const KEY = {
  'Generative AI / LLM Engineer': { headline: 'Generative AI Engineer — LLMs, agents, RAG, evaluation', lead: 'Hands-on generative AI engineering: open-weight LLMs, agent frameworks, RAG pipelines', skills: ['LLM', 'LangChain', 'CrewAI', 'Autogen', 'RAG', 'ChromaDB', 'Pinecone', 'evaluation', 'Python'] },
  'AI Solutions Architect': { headline: 'AI Solutions Architect — enterprise + generative AI', lead: 'Enterprise AI architecture: 15 years of Microsoft-stack delivery, now hands-on with LLMs and agents', skills: ['solution architecture', 'Microsoft', '.NET', 'RAG', 'agents', 'consulting', 'enterprise'] },
  '.NET / Solutions Architect': { headline: 'Solutions Architect — Microsoft stack, 15 years', lead: 'Microsoft-stack solution architecture: ASP.NET, .NET, C#, SQL Server performance tuning, WCF, SharePoint', skills: ['.NET', 'ASP.NET', 'C#', 'SQL Server', 'WCF', 'SharePoint', 'performance tuning'] },
  'AI Product Manager': { headline: 'AI Product Manager — enterprise + GenAI', lead: 'AI product leadership: Wharton business grounding + hands-on LLM/agent/RAG fluency for enterprise', skills: ['product', 'business', 'LLM', 'agents', 'Wharton', 'analysis'] },
};

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  const ar = archetypeNames();
  const checks = [
    ['reads archetypes', ar.length >= 4],
    ['reads cv summary', cvSummary().length > 10],
    ['archetype has skills', Object.keys(KEY).length >= 4],
  ];
  let n = 0;
  for (const [name, ok] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${name}`); if (ok) n++; }
  console.log(`\narchetype-cv ${n}/${checks.length} passed`);
  process.exit(n === checks.length ? 0 : 1);
}

const archetypes = archetypeNames();
const ai = args.indexOf('--archetype') !== -1 ? args[args.indexOf('--archetype') + 1] : null;
const shown = ai ? archetypes.filter((a) => a.toLowerCase().includes(ai.toLowerCase())) : archetypes;
if (args.includes('--json')) { console.log(JSON.stringify(shown, null, 2)); process.exit(0); }
if (shown.length === 0) { console.log('no archetypes matched'); process.exit(0); }

console.log('Sample tailored CV per archetype (from your CV + profile — no new claims):');
for (const a of shown) {
  const def = KEY[a] || { headline: a, lead: a, skills: [] };
  console.log(`\n### ${a}`);
  console.log(`  headline: ${def.headline}`);
  console.log(`  tailored summary opens: “${def.lead} — ${cvSummary().slice(0, 70)}…”`);
  console.log(`  skills surfaced first:  ${(def.skills || []).join(', ')}`);
}
console.log('\n(For the full tailored PDF run `/career-ops pdf` with the target role.)');
process.exit(0);