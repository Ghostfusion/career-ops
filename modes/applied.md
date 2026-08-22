# Mode: agents — the applied-search toolkit

A set of zero-LLM companion tools that close the loops career-ops' core
evaluation leaves open: turning evaluations into applications, watching the
deadlines that follow, learning from rejections, warming the pipeline from
LinkedIn alerts, and checking your target comp is realistically available.

Seven standalone scripts back this mode; each has a dedicated purpose, none
touches the tracker directly, and all are wired into the routing menu.

| Tool | What it does | Command |
|------|--------------|---------|
| `launchpad` | Turns evaluated rows into ACT/PREP/HOLD/SKIP tiers + chains cover→email→apply | `node launchpad.mjs` |
| `proof-point-bank` | Track unpublished→published artifacts as assets that unblock launchpad rows | `node proof-point-bank.mjs` |
| `watch-deadlines` | Flag reply-by / offer-expiry / interview-window dates at session start | `node watch-deadlines.mjs` |
| `close-loop` | Turn a rejection into a concrete CV/portfolio edit so failures improve the profile | `node close-loop.mjs <row#>` |
| `ingest-linkedin` | Turn LinkedIn job-alert text into pending pipeline rows (zero-token) | `node ingest-linkedin.mjs` |
| `salary-trend` | Track advertised comp bands per role family vs your target | `node salary-trend.mjs` |

All of them follow the same contract as the rest of career-ops:
- **They never submit, send, or write the tracker by hand.** Status transitions
  stay on `node set-status.mjs`.
- **They read** tracker/reports/profile; only `ingest-linkedin` writes the
  pipeline inbox (appending `- [ ] {url}` rows — the thing `pipeline` drains),
  and `proof-point-bank` writes its own ledger + optional dismiss state.
- Zero LLM tokens — every number you see is computed from your own files.

---

## 1. `proof-point-bank` — capture the artifacts that unblock you

Your strongest matches are gated by "send us the GitHub", "apply with a runnable
eval demo", "publish the artifacts". This tool manages those **proof points** as
an asset and shows which open launchpad rows each one, once published, clears.

```
node proof-point-bank.mjs --list                       → ledger
node proof-point-bank.mjs --add "RAG eval harness" --status building --blocks "eval|harness|demo"
node proof-point-bank.mjs --set "RAG eval harness" published --url https://github.com/…
node proof-point-bank.mjs --unblocks                → which launchpad rows (≥3.5) it unblocks
```

The ledger is `data/proof-points.tsv` (user layer). When you mark a proof
`published`, re-run launchpad — its blocked `PREP FIRST` rows should tip to ACT.

## 2. `watch-deadlines` — don't drop the ball async

Flag dates inside a lookahead window (default 7d) from tracker notes
(`respond-by YYYY-MM-DD`, `expires …`, `window …`, `by …`) and follow-up rows.
Run at session start before anything else.

## 3. `close-loop` — rejection becomes a CV-improvement cycle

`node close-loop.mjs 42` reads that row's report gaps and proposes a concrete
edit (to `cv.md`, `modes/_profile.md`, or a launchpad-prep task). It only
**proposes** — you confirm before it applies.

## 4. `ingest` — warm the pipeline from LinkedIn alerts

Paste an alert email body (or a file path) → it extracts LinkedIn job URLs and
appends them as pending `- [ ] {url}` rows to `data/pipeline.md`, dedpuping
against what's already there. No Gmail API key needed — it's just text parsing.

## 5. `salary-trend` — check your target is real

Reads every report's advertised comp, groups it by role family (SWE, PM,
solutions, architect, …), and shows the observed span + median against your
`compensation.target_range` in profile.yml — so you know before pursuing a
family whether it can clear your floor.

## 6. `watch-deadlines` quick call

To scan at startup (as the mode agent described below): just run
`node watch-deadlines.mjs` — it's designed to be the first thing at session
opening so a reply window is never missed.

---

## When to run which

| Situation | Tool |
|-----------|------|
| "I have a stack of evaluations — what do I apply to?" | launchpad |
| "I keep reading 'publish a demo' but have nothing to show" | proof-point-bank |
| First application just submitted / recruiter gave a deadline | watch-deadlines |
| A role rejects you and you feel stuck on why | close-loop |
| LinkedIn alerts land but the pipeline stays empty | ingest-linkedin |
| Questioning whether $150–200K is on offer | salary-trend |

Each is a single command, zero tokens, and safe (read-mostly, confirm-before-write
on any user-layer edit). The agent surfaces these alongside the core modes as
needed — not as a separate menu, but as sharper buttons on the same dashboard.