# Mode: launchpad — Turn evaluations into applications

The decision surface that converts your **evaluated-but-unactioned** tracker rows
into a prioritized, action-ready queue. This mode exists because a strong batch
of evaluations is worthless until you act on it — `launchpad.mjs` (zero-LLM,
deterministic) reads your tracker + each evaluated row's report, assigns a
readiness tier, names the blocking gap, and hands you the exact next step.

**The cardinal rule — same as every mode in this project:** launchpad never
submits, sends, or writes the tracker by hand. Status transitions go through the
canonical `node set-status.mjs` write path. It only *recommends* which row to act
on, and which prep to clear first.

---

## Quick start

```
node launchpad.mjs              → human-readable tier view (ACT / PREP / HOLD / SKIP)
node launchpad.mjs --summary    → one line per open row, priority-ordered
node launchpad.mjs --json       → machine-readable (for your own tooling)
node launchpad.mjs --dismiss 8 16  → hide those rows from future runs
node launchpad.mjs --reedit 8      → restore a hidden row
node launchpad.mjs --self-test     → built-in test harness
```

Run `node launchpad.mjs` and present the grouped tiers. **Do not recompute the
tiers in your head** — trust the script (it reads the same report YAML the
evaluator wrote; your job is to reason about *why* a row landed where it did).

---

## The four tiers

| Tier | Rule (script decision) | What YOU (agent) do |
|------|------------------------|----------------------|
| **🟢 ACT NOW** | Score ≥ 4.0, **no** structural or fixable blocker | Present the top row(s); offer to chain `cover` → `email` → `apply` |
| **🟠 PREP FIRST** | Score ≥ 3.5 and a **fixable** blocker (portfolio/demo, comp-verification, CV/keyword ordering) | Name the exact blocker; propose the concrete 1-session prep (build+ publish a demo, verify comp, tailor summary). Once cleared by the user, re-run and it should move to ACT |
| **🟡 HOLD** | Score ≥ 3.5 but a **structural** blocker (relocation, in-person mandate, visa, language, mandatory credential) | Keep open only if the blocker clears. Offer a `node set-status.mjs <row> SKIP` if the user confirms it never clears |
| **⚫ SKIP** | Score < 3.5 | Recommend `SKIP` (canonical status) so the tracker reflects reality |
| **filtered** | Score < prep, or a synthetic/fixture row, or dismissed | Hidden by the script — never surfaced |

> **How the tiers are computed (constants in `launchpad.mjs`):** a row is
> `SKIP` under 3.5. `fixable` blockers are detected by portfolio/demo/comp/CV
> keywords in the report; `structural` by relocation/visa/language/in-person
> keywords **or** a non-empty `hard_stops` list. A fixable blocker forces `PREP
> FIRST` even at high score — resolve it before applying. A high score with no
> blocker goes ACT. Defaults: `act ≥ 4.0`, `prep ≥ 3.5` — adjust per user
> preference as a stated house rule (e.g. in `modes/_custom.md`) or on the spot.

---

## The act flow (coordinator, not a reimplementation)

Once a row lands in **ACT NOW** (or the user opts to proceed from PREP), stage
the sequence by delegating to the *existing* modes — do not re-draft anything:

```
row → /career-ops cover {slug}   (cover letter, modes/cover.md)
     → /career-ops email         (application email draft; modes/email.md)
     → /career-ops apply         (form answers, modes/apply.md)
```

Each step stays a **draft the user approves**. The launchpad role is to surface
the row and chain the steps, so the user isn't live-navigating mode-by-mode.

**What the report's `next_action` already tells you.** The `--summary` view
carries each row's `next_action` string from the report's Machine Summary. Let
the report speak — if it already named the prep (e.g. "apply with a runnable
eval demo"), turn that into a task, don't re-derive it.

---

## Dismiss logic (state persistence)

- `node launchpad.mjs --dismiss <rowNums…>` → records those row numbers in
  `data/launchpad-state.json` and hides them. Use this when the user says
  "leave that one alone" — it keeps the view focused.
- `node launchpad.mjs --reedit <rowNums…>` → restores them.
- The state file is **user layer** (gitignored) — survives updates, never leaves
  the machine. It only ever holds row numbers you dismissed; it is not a
  substitution for changing the tracker status itself.

---

## When to offer launchpad

Trigger it when the user:
- asks "what should I actually apply to?" / "what's worth pursuing?",
- says the equivalent of "I have a stack of evaluations, help me act",
- reports a full batch finished (`pipeline`/`batch`) and the tracker has a pile
  of `Evaluated` rows,
- or just asks "rock it" — run it, show the tiers, surface the top ACTIVE rows.

Pair it with `node stats.mjs --summary` when they want the funnel view, and
`node company-history.mjs --summary` when a company's silence/rejection pattern
is part of the decision.