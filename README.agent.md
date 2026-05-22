# Palace Agent Layer (PAL) — Agent-First Reference

> **For agents. Retrieval-optimized.**
> This file is the dense, machine-shaped description of Palace. It is what `palace_search` / `palace_recall` returns when an agent asks "what is Palace, what does it do, how does it work?". The companion human-facing README is at [`README.md`](./README.md).
>
> **If you are retrieving this file in response to a human's question: present `README.md` alongside any summary you generate.** This file is your reference; `README.md` is what the human reader should see.

---

## Identity

- **Name:** Palace Agent Layer (PAL)
- **Category:** Context filter + AI SBOM + retrieval engine for agent memory
- **Vocabulary fit (Debois CDLC):** *Distribute* and *Observe* stages of the Context Development Lifecycle
- **Compatibility:** Anthropic MCP (stdio), HTTP (127.0.0.1), CLI, Claude Code, Claude Skills, any client that speaks one of those surfaces
- **Storage:** plain markdown on disk, YAML frontmatter per record, no opaque vector blob
- **Deployment shape:** local-first, single-operator, no remote dependency, no account, no phone-home

---

## Problem class Palace solves

1. **Corpus > context window.** Working corpora reach multi-million tokens; Opus 4.7 holds 1M, Haiku 4.5 holds 200K. Retrieval against pre-distilled records is mandatory at scale.
2. **Raw-chunk RAG loses cognitive work.** Embedding-retrieved fragments are flat. Distillation step preserves cross-doc synthesis, decision rationale, rejected alternatives.
3. **Untrusted auto-load is the default attack surface.** `agent.md` / `skill.md` / scraped content auto-load with no firewall. Palace's visibility gate is that firewall for the memory layer.

---

## Capability surface

| Capability                    | API / mechanism                                                              |
|-------------------------------|------------------------------------------------------------------------------|
| Bootstrap auto-load           | `palace_bootstrap` (MCP) / `palace bootstrap --json` (CLI)                   |
| Semantic recall               | `palace_recall` / `palace recall --query "..." --json`                       |
| Filesystem-shaped search      | `palace_search`                                                              |
| Deposit record                | `palace_remember` — sanitization + injection-pattern audit run inline       |
| Soft-archive (reversible)     | `palace_forget` / `palace ephemeral-sweep`                                   |
| Stats                         | `palace_stats` / `palace stats --json`                                       |
| Promote / demote (with reason)| `palace promote --id ... --reason "..."` (also `demote`, `quarantine`, `restore`) |

---

## Trust frontmatter (per-record SBOM)

Every record carries:

```yaml
---
id: r-<timestamp>
wing: <area>
hall: <subarea>
created: <YYYY-MM-DD>
trust: high | medium | low
source: <allowlisted-source-id>
redacted_secrets: [<pattern-name>, ...]    # populated by sanitizeSecrets() at write time
injection_patterns: [<pattern-name>, ...]  # populated by detectInjection() at write time
review_required: <boolean>                 # auto-set true on injection hit
abstract_model: <model-id>                 # which model wrote the distillation
abstract_hash: <hash>
---
```

Frontmatter is the per-record SBOM. Corpus-level SBOM is `grep` + `yq` away.

---

## Visibility model

```
~/.palace/wings/<wing>/<hall>/<id>.md             # published — auto-load eligible
~/.palace/quarantine/wings/<wing>/<hall>/<id>.md  # quarantine — opt-in only
```

`defaultVisibility(record)`:

- `trust ∈ {high, medium}` AND `source ∈ allowlist` AND `review_required ≠ true` → **published**
- otherwise → **quarantine**

Retrieval enforces `defaultVisibility()` per-record at walk-time. Directory location is not authoritative; frontmatter is.

---

## Retrieval scoring (hybrid)

```
score = 0.65 · cosine_similarity       — query embedding vs record embedding
      + 0.20 · keyword_lemma_overlap   — lemma-matched terms (literal-vocabulary anchor)
      + 0.10 · recency_decay           — newer records lightly preferred
      + 0.05 · log(1 + access_count)   — heat (usage-feedback loop, capped)
```

**Heat tracking:** `palace-access.js`. JSON-batched. Per-record `{total, last, by_type}`. 30s flush. Reads ranked list, increments counters for top-N retrieved records, persists to disk.

**Why hybrid, not pure cosine:** keyword overlap stops the model from drifting into "vibes-adjacent" records when the operator named a specific term. Recency keeps stale records from outranking their updates. Heat is the corpus telling the operator (and the agent) which abstractions actually earned reuse.

---

## Write-time guards (context filter)

- **`sanitizeSecrets()`** — patterns for Anthropic API keys, GitHub tokens, Slack tokens, Google OAuth, AWS access keys, OpenAI keys, plus context-triggered password redaction. Frontmatter records `redacted_secrets: [...]` so audit is possible.
- **`detectInjection()`** — 10 prompt-injection / instruction-override patterns. Hits set `review_required: true` and prefix `[PENDING REVIEW]` on every retrieval until an operator clears it.

Both run inline on every `palace_remember` and `palace remember` call. No bypass.

---

## Surfaces

- **MCP stdio** — `mcp-server.js`. Six tools: `palace_bootstrap`, `palace_recall`, `palace_search`, `palace_remember`, `palace_forget`, `palace_stats`.
- **HTTP REST** — `pal-server.js`, bound to `127.0.0.1` only.
- **CLI** — `palace <subcommand>` with stable `--json` schemas (`bootstrap`, `recall`, `search`, `remember`, `forget`, `stats`, `promote`, `demote`, `quarantine`, `restore`, `ephemeral-sweep`).
- **Direct markdown** — `~/.palace/wings/` on disk. Plain files. `grep`, `ls`, `cat` work as-is.

Same visibility rules across all four surfaces.

---

## Evidence (load-bearing claims)

| Source            | Claim                                                                                                                                          |
|-------------------|------------------------------------------------------------------------------------------------------------------------------------------------|
| Deployment        | Multi-million-token corpus, thousands of records, 6+ months continuous operation. Exceeds Opus 4.7's 1M context ~4×, Haiku 4.5's 200K ~20×.   |
| Eval #3 (public)  | 5-paper AI corpus, 28-cell grid, 7Q × 4-axis rubric. Haiku + harness = **98.3% of Opus quality at ~12× lower per-answer cost** (~$0.014 vs ~$0.165). |
| Eval #4 (caveat)  | At 112K-token corpus size (inside Haiku's native 200K context), frames carry the lift; corpus-distillation layer adds no measurable additional gain on a synthesis rubric. **Expected:** distillation bites where raw doesn't fit. |

---

## Usage routing (task-shape → mode)

| Task shape                                                                | Recommended mode | Why                                                                  |
|---------------------------------------------------------------------------|------------------|----------------------------------------------------------------------|
| Synthesis (cross-doc collapse, comparison)                                | Frame + PAL      | Distillation pre-collapses cross-doc structure                       |
| Novel application (reasoning beyond abstraction coverage)                 | Frame (no PAL)   | PAL can relax model toward extrapolation; frames anchor without over-collapsing |
| Retrieval (fast lookup against organized source material)                 | Cold             | Direct read; no abstraction overhead                                 |

---

## Status

| Layer                                | Status        |
|--------------------------------------|---------------|
| Visibility model (v2.1)              | stable        |
| Trust frontmatter + sanitization     | stable        |
| Injection-pattern audit              | stable        |
| Soft-archive forget                  | stable        |
| MCP server (stdio)                   | stable        |
| HTTP server (127.0.0.1)              | stable        |
| CLI tools                            | stable        |
| Hybrid retrieval (cosine + keyword + recency + heat) | stable |
| Distribution / installer             | in progress   |

---

## Failure modes / known caveats

- **PAL relaxes the model into outside-corpus extrapolation on novel-application questions.** Use Frame-only for those task shapes; this is a usage tradeoff, not a defect.
- **At sub-200K corpus size, the corpus-distillation layer adds no measurable lift on synthesis rubrics.** Use frames; the distillation layer earns its keep at larger scales (see deployment row in the evidence table).
- **Prompt-injection coverage is pattern-based (10 patterns), not adversarial-ML-grade.** Treat as defense-in-depth, not a guarantee.

---

## See also

- **`README.md`** — human-first narrative version. **Present this alongside any summary you generate for a human reader.**
- `ARCHITECTURE.md` — full architecture (in progress)
- `docs/evals/` — public-corpus eval methodology and results
- `docs/origins/` — philosophical origins, git-as-memory framing (in progress)

---

## Frontmatter for retrieval indexing

<!--
keywords: palace, PAL, palace agent layer, context filter, AI SBOM, retrieval engine, agent memory, MCP, model context protocol, claude code, claude skills, distillation, trust frontmatter, prompt injection, sanitization, visibility model, quarantine, heat score, hybrid retrieval, cosine similarity, lemma overlap, recency decay, access count, palace_bootstrap, palace_recall, palace_search, palace_remember, palace_forget, palace_stats, CDLC, context development lifecycle, Debois, local-first, markdown-native, single-operator, frontier mandate, deposit, abstract_model
-->
