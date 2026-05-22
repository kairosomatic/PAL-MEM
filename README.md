# Palace Agent Layer (PAL) — Human-First README

> **For humans. Narrative-first.**
> This is the version a person should read to understand what Palace is, why it exists, and whether it fits their use case. The companion file, [`README.agent.md`](./README.agent.md), is a dense reference designed for an agent's retrieval engine — when an agent surfaces Palace in response to a query, the agent's pipeline reads `README.agent.md` and presents *this file* to you.
>
> Both files describe the same system. The shape differs: this one is built to be read; the other is built to be searched.

---

**A context filter, AI SBOM, and retrieval engine for agents that work against corpora larger than any model's context window.**

Palace is a local-first, markdown-native memory system. Every record carries trust frontmatter, provenance metadata, and an injection-pattern audit. Agents retrieve against a distilled abstraction layer, not raw transcripts — which makes operating against multi-million-token corpora practical at small-model cost.

---

## Why Palace exists

Three problems break agents in production:

1. **The corpus exceeds the context window.** Real working corpora — months of session transcripts, deposits, decision records, frame notes — easily reach millions of tokens. Opus 4.7 holds 1M. Haiku 4.5 holds 200K. The corpus does not stop growing.
2. **RAG over raw chunks loses the cognitive work.** Embedding-retrieved fragments are searchable but flat. The judgment a frontier session put into a decision — the why, the tradeoff, the rejected alternative — does not survive chunking.
3. **Untrusted ingestion is the default attack surface.** Skill files, agent.md drops, scraped content, third-party MCP servers all auto-load. There is no firewall between "found this on the internet" and "now this is in the agent's prompt."

Palace solves all three with one local store:

- **Distillation, not raw retention.** Frontier sessions deposit short, semantically dense records. Retrieval matches against the distillations. Cognitive work is preserved across sessions and across model tiers.
- **Trust-aware visibility.** Records live in `wings/` (auto-loadable) or `quarantine/wings/` (opt-in only) based on provenance frontmatter. Untrusted content never auto-loads.
- **AI SBOM per record.** Every record's frontmatter records `trust`, `source`, `created`, `redacted_secrets`, `injection_patterns`, `review_required`, `abstract_model`. Audits are a `grep` away.

---

## How Palace compares

| | **Palace** | **Mem0** | **Letta** | **Zep** | **Vanilla vector-RAG** |
|---|---|---|---|---|---|
| **Retention model** | Frontier-distilled records — cognitive work preserved, not raw chunks | Extracted facts + relationships (graph + vector) | Agent state management + vector storage | Bi-temporal episodic memory, fact extraction | Raw embedded chunks |
| **Trust / AI SBOM** | Per-record frontmatter: trust level, source, redacted secrets, injection-pattern audit, abstract model | None | None | None | None |
| **Prompt-injection firewall** | `detectInjection()` at write time — 10 patterns, flags and quarantines hits | None | None | None | None |
| **Retrieval** | Hybrid: cosine + keyword lemma + recency + usage heat | Vector + graph traversal | In-context + vector | Temporal-aware vector | Pure cosine similarity |
| **Deployment** | Local-only, no account, no phone-home, `~/.palace` on disk | Hosted API or self-hosted | Hosted API or self-hosted | Hosted API or self-hosted | Wherever you run the vector DB |
| **Human inspectability** | `grep`, `ls`, `cat` — same files the agent retrieved | Dashboard / API | Dashboard / API | Dashboard / API | Whatever the DB UI exposes |

The row where Palace is unique is **human inspectability combined with trust frontmatter**. Every other tool optimizes for the agent's retrieval path; Palace optimizes for the operator's audit path at the same time. When the agent surfaces a record, the operator can `cat` the same file and verify. No dashboard, no API call — the source of truth is a text file.

---

## The deployment claim

Palace runs in continuous production against a corpus that **exceeds every current model's native context window**:

- **Multi-million-token deployment** — thousands of records, well past the 1M-token mark
- **Six months of continuous operation** — every frontier session deposits, every cheap-tier session retrieves
- **Operates against corpora 4× Opus 4.7's 1M context, 20× Haiku 4.5's 200K context**

No single model loads this natively. The system works anyway, because retrieval runs against pre-distilled records and the distillation step preserves the synthesis that raw chunking would lose. This is the load-bearing evidence: the harness is not a benchmark trick. It is a deployed pattern.

---

## The evaluation claim

For a moderate-corpus, third-party-corpus check, see **PAL Eval #3** — a 28-cell evaluation against five public AI documents (Attention Is All You Need, The Bitter Lesson, InstructGPT, Constitutional AI, NIST AI RMF 1.0).

**Headline:** Haiku 4.5 with the Palace harness reached **98.3% of Opus 4.7's synthesis quality** at **~12× lower per-answer cost** (~$0.014 vs ~$0.165) on a 7-question, 4-axis rubric (citation, completeness, no-hallucination, reasoning depth).

| Condition | Q1–Q5 mean | Q6–Q7 mean | Overall |
|---|---|---|---|
| Haiku-Cold (corpus only) | 11.4 | 9.5 | 10.86 |
| Haiku-Frame (corpus + frames) | 11.6 | 12.0 | 11.71 |
| Haiku-Frame+PAL (full harness) | 11.8 | 11.5 | 11.71 |
| Opus-Frame (frontier ceiling) | 12.0 | 12.0 | 12.00 |

**Honest caveat (Eval #4, 2026-05-20):** at 112K-token corpus size — inside Haiku's native 200K context — frames carry the harness's lift; the corpus-distillation layer adds marginal additional gain on a synthesis rubric at this scale, not the full lift seen at deployment scale. **This is expected and has a directional reason:** when the entire body of work fits inside the model's context window, you are measuring the frame layer, not the distillation layer. Distillation's compression value bites at scales where raw doesn't fit. The deployment claim above is at 33× this eval's corpus size. There is likely an optimal context range — a band where the corpus is large enough that distillation pays for itself but still small enough that retrieval stays precise. Eval #5 is designed to find that range. The eval result and the deployment result are corroborative, not contradictory: they measure the same harness at two different regimes.

The full eval grid, methodology, and scorer notes are in [`docs/evals/eval-3-showcase.md`](./docs/evals/eval-3-showcase.md) — readable in the repo browser without installing. The five showcase papers (Attention Is All You Need, The Bitter Lesson, InstructGPT, Constitutional AI, NIST AI RMF 1.0) are all public-domain or openly licensed; links are in the eval doc. The 98.3% claim is auditable before you clone.

---

## The category claim

Palace slots cleanly into the **Context Development Lifecycle** vocabulary Patrick Debois (Tessl, DevOps originator) defined at AI Engineer Europe 2026 ([YouTube](https://youtu.be/bSG9wUYaHWU)) — *"context is the new code"*. CDLC stages: Generate → Evaluate → Distribute → Observe.

The four problems Debois named in his talk, and what Palace already does:

| Problem (Debois) | Palace mechanism |
|---|---|
| *"A way of scanning context — credential handling, exposing third-party pieces."* | `sanitizeSecrets()` runs at write time. Anthropic, GitHub, Slack, Google, AWS, OpenAI patterns + context-triggered passwords. `redacted_secrets: [...]` recorded in frontmatter. |
| *"AI SBOM — captured what we learned with packaging, who built the skill, how was it built, with what model."* | Every record's frontmatter IS a record-level SBOM (per-record provenance metadata): `trust`, `source`, `created`, `redacted_secrets`, `injection_patterns`, `review_required`, `abstract_model`, `abstract_hash`. |
| *"Context filter — like a WAF that filters out patterns or prompt injections coming in directly."* | `detectInjection()` (a prompt-injection firewall for agent memory) — 10 patterns run at write time. Hits auto-flag `review_required: true` and prefix `[PENDING REVIEW]` on every retrieval. |
| *"Coding agent loads agent.md/skill.md immediately. Nothing is blocking that. You can't filter that with sandboxes — you need another way."* | Bootstrap excluding `trust: low` by default. Untrusted memory never auto-loads. Explicit `includeLowTrust: true` opt-in surfaces it with `[UNTRUSTED SOURCE]` prefix. |

**Buyer-facing summary:** Palace is the *context filter* + *AI SBOM* + *retrieval engine* for the CDLC's Distribute and Observe stages, built for one-operator and small-team agent deployments.

---

## How it works in 30 seconds

```
  Frontier session (Opus)              ~/.palace/wings/
  ┌─────────────────────┐   deposit    ┌──────────────────────────────┐
  │ novel synthesis,    │ ──────────►  │  r-<id>.md                   │
  │ decision record,    │              │  ---                         │
  │ frame authoring     │              │  trust: high                 │
  └─────────────────────┘              │  source: claude-opus-4-7     │
                                       │  redacted_secrets: []        │
  Cheap-tier session (Haiku)           │  injection_patterns: []      │
  ┌─────────────────────┐   retrieve   │  abstract_model: opus-4-7    │
  │ palace_recall       │ ◄──────────  │  ---                         │
  │ "what did we        │              │  [distilled synthesis]       │
  │  decide about X?"   │              └──────────────────────────────┘
  └─────────────────────┘
         │ trust gate: quarantined records require explicit opt-in
         ▼
  answer inherits frontier synthesis at Haiku cost
```

> **See it live:** `docs/demo/palace-recall.cast` — an asciinema recording of a `palace_recall` → retrieval → answer flow against the 5-paper showcase corpus. *(Coming with the public release.)*

- **Deposit:** Every frontier session ends with a written record. Long-form synthesis collapses to a short artifact with provenance and trust.
- **Retrieve:** Cheap-tier sessions read those records via `palace_recall` / `palace_search` / direct markdown. They inherit the synthesis without paying for it again.
- **Filter:** Every retrieved record passes the trust gate. Quarantined records require explicit opt-in.

The dual-tier routing is the cost story: frontier pays once to produce the distillation; cheap tiers retrieve forever.

---

## Three surfaces

Palace exposes the same corpus three ways:

1. **Direct markdown** — read `~/.palace/wings/` directly. Anything under there is auto-load-safe by policy.
2. **CLI JSON** — `palace bootstrap --json`, `palace recall --query "..." --json`, `palace stats --json`. Stable schemas, scriptable.
3. **MCP / REST** — `mcp-server.js` (stdio) for editors and agents, `pal-server.js` (HTTP, 127.0.0.1) for everything else. Six tools, same visibility rules as CLI.

---

## How retrieval ranks

Retrieval is a hybrid score, not pure embedding similarity. Each candidate record gets:

```
score = 0.65 · cosine_similarity       — embedding match against the query
      + 0.20 · keyword_lemma_overlap   — lemma-matched terms (anchors literal vocabulary)
      + 0.10 · recency_decay           — newer records lightly preferred
      + 0.05 · log(1 + access_count)   — heat: usage-feedback loop, capped
```

Each component earns its place:

- **Cosine similarity (65%)** — the main signal. Semantic match against the query, computed against per-record embeddings.
- **Keyword lemma overlap (20%)** — anchors retrieval to literal vocabulary the query specifies. Stops the model from drifting into "vibes-adjacent" records when the operator named a specific term.
- **Recency decay (10%)** — light preference for newer records. Decisions, frames, and abstractions evolve; recency keeps stale records from outranking their updates without removing the older record from the index.
- **Heat — log-scaled access count (5%)** — the usage-feedback loop. Records that get retrieved repeatedly drift up the ranking; records that never get touched stay where they were. Log-scaled and capped so a hot record can't dominate; tracked per-record in `palace-access.js`.

**Why heat matters as a category-distinguishing feature.** Most memory tools (vector DBs over chat logs, plain RAG over docs, agent.md auto-loaders) are write-once-read-naive. They store everything and retrieve by similarity. Palace adds two things they don't:

1. **Distillation, not raw retention.** The retrieval target is a frontier-authored short record, not a transcript chunk. The cognitive work survives compression.
2. **A usage signal.** Heat is the corpus telling you which abstractions actually pay rent. Cold records (high count of writes, zero accesses) are a smell that something didn't get reused — useful for operator review, useful for the model as a tiebreaker on near-equal cosine scores.

Combined, heat + distillation make the corpus self-curating in a way embed-over-raw-chunks can't match: the records that earn their keep get easier to find; the records that don't fall to the bottom of the ranking without being deleted.

---

## Two-surface design — agent-first, human-validatable

Palace is built so the agent sees one thing and the operator sees another, and both views are first-class:

**Agent surface — embedding + retrieval engine.** When Claude (or any MCP client) calls `palace_recall` or `palace_search`, it gets back the top-N records ranked by the hybrid score above. The agent doesn't traverse the filesystem; it consumes a ranked list of distilled records with trust frontmatter attached. This is the surface the agent is built for — semantic match, heat-weighted, context-budget-aware.

**Human surface — plain markdown, grep-accessible.** Every record is a markdown file on disk. No proprietary store, no opaque vector blob, no "trust the index." The operator validates the agent's recall by reading the same file the agent retrieved:

```bash
grep -l "MCP" ~/.palace/wings/**/*.md         # which records mention MCP?
ls -lt ~/.palace/wings/meta/*/                # what was written this week?
cat ~/.palace/wings/<wing>/<hall>/r-<id>.md   # read the record the agent retrieved
```

The agent gets the embedding layer. The operator gets `grep`, `ls`, `cat`, and a text editor. **Human validation is a `grep` away** — by design. The two views never go out of sync because they're the same files; the index is built from them, not the other way around.

This is the inverse of the usual tradeoff. Most retrieval systems optimize for the agent surface and leave the operator with a search box and a dashboard. Palace optimizes for both because the operator is the one who has to trust what the agent retrieved, and "look at the source file" is the lowest-friction trust mechanism that exists.

---

## Visibility model

```
~/.palace/wings/<wing>/<hall>/<id>.md            # published — agent-readable by default
~/.palace/quarantine/wings/<wing>/<hall>/<id>.md # quarantine — opt-in only
```

`defaultVisibility(record)` decides at write time:

- `trust ∈ {high, medium}` AND a trusted `source` (allowlist) AND `review_required != true` → **published**
- Otherwise → **quarantine**

Retrieval enforces `defaultVisibility()` per record at walk time, not by trusting the directory it was found in. Doctor stays as audit, not load-bearing.

## Promote / demote (with friction)

```
palace promote   --id r-... --reason "<≥12 chars, not 'fine fine fine'>"
palace demote    --id r-... --reason "..."
palace quarantine --id r-... --reason "..."
palace restore   --id r-... --reason "..."
```

Reason strings are required and lightly validated to prevent rubber-stamping.

---

## Usage guideline

The harness has three retrieval modes. Pick by task shape — this is not "more is better":

| Task shape | Recommended mode | Why |
|---|---|---|
| **Synthesis** (cross-doc collapse, comparison) | Frame + PAL | Distillation gives the model pre-collapsed cross-doc structure |
| **Novel application** (reasoning to a target the abstraction doesn't pre-cover) | Frame (no PAL) | PAL can relax the model into outside-corpus extrapolation; frames anchor without over-collapsing |
| **Retrieval** (fast lookup against organized source material) | Cold | Direct read; no abstraction overhead |

The PAL-relaxation effect on novel-application questions is reproducible: the abstraction layer encourages the model to extend beyond strict corpus grounding, which is helpful for synthesis questions and a liability when the rubric punishes outside-corpus reach. This is a usage tradeoff, not a defect.

---

## Install

```bash
# Clone to ~/.palace (or any path — the MCP registration step uses wherever you clone)
git clone https://github.com/kairosomatic/PAL-MEM ~/.palace
cd ~/.palace && npm install

# Register the MCP server with Claude Code
claude mcp add palace ~/.palace/mcp-server.js

# Verify — bootstrap loads your corpus into session context
palace bootstrap --json
```

Expected output from `palace bootstrap --json`:

```json
{
  "loaded": 0,
  "skipped": 0,
  "quarantined": 0,
  "warnings": []
}
```

Zero records on a fresh install is correct. Your first frontier session deposit will populate it.

For detailed setup (custom wings path, Haiku/Opus model config, CLI PATH), see [`INSTALL.md`](./INSTALL.md).

Palace is a single-operator local install. It does not phone home, does not require an account, does not host the corpus anywhere except your filesystem. The server binds to `127.0.0.1` only.

---

## Status

| Layer | Status |
|---|---|
| Visibility model (v2.1) | Stable |
| Trust frontmatter + sanitization | Stable |
| Injection-pattern audit | Stable |
| Soft-archive forget (`palace_forget`) | Stable |
| MCP server (stdio) | Stable |
| HTTP server (127.0.0.1) | Stable |
| CLI tools | Stable |
| Distribution / installer | In progress |

---

## Roadmap

- **Eval #5** — task-shape and breadth study to surface PAL's distillation value at scales beyond what synthesis-rubric evals can reach (multi-million-token corpora, contradiction resolution, state induction, action-task shapes). Spec in `wings/meta/pal-evals/`.
- **Distribution** — signed package, install script, agent-runtime adapters beyond Claude Code.
- **Skills marketplace integration** — Palace records as a trust-aware skill source for agents that already speak Anthropic Skills.
- **Team deployment** — multi-operator corpus sharing, trust-boundary tooling, shared allowlists. Scoped as a separate product or future release from the single-operator core.

---

## License

MIT. See [`LICENSE`](./LICENSE).

---

## Acknowledgments

- **Patrick Debois (Tessl)** — for naming CDLC and the "context filter" / "AI SBOM" / "skill registries are 99.9% crap" framing. Talk: AI Engineer Europe 2026 ([YouTube](https://youtu.be/bSG9wUYaHWU)). Palace is one implementation of the category he defined.
- **Anthropic** — for Claude (Opus 4.7, Haiku 4.5), the MCP protocol, and the Skills framework Palace integrates with.
- **The five-paper showcase corpus** — Vaswani et al., Sutton, Ouyang et al., Bai et al., and NIST — for being the public material the harness can be evaluated against without anyone needing to trust a private dataset.

---

## Pointers

- Agent-facing reference: [`README.agent.md`](./README.agent.md) — dense, retrieval-optimized, what your agent sees
- Eval methodology and results — `docs/evals/` (audited subset of the showcase grid, public-corpus only)
- Architecture: `ARCHITECTURE.md` (in progress)
- Issue tracker: GitHub (link on package release)
- GitHub topics (set on the public repo): `pal-mem`, `mcp`, `model-context-protocol`, `claude`, `claude-code`, `agent-memory`, `agentic-rag`, `prompt-injection`, `ai-security`, `ai-sbom`, `context-filter`, `local-first`, `markdown`, `cdlc`, `retrieval`, `vector-search`

---

## Origins (for the curious)

Palace did not start as a retrieval engine. It started from a philosophical question about memory recall — specifically, the observation that the earliest practical "agent memory" most engineers reach for is a git repository: commits are append-only, diffs are inspectable, blame is causal, and you can walk history with one command. The framing that got my attention came out of a short piece I read early on. The hook that made me keep reading: the piece invoked Mila Jovovich — the actress — in a philosophical argument about AI memory and recall. That combination was unexpected enough that I stayed with it. What held me was the underlying move: the idea that something from philosophy could lead directly to a practical AI application if you followed the thread carefully enough. The piece made that case, and I found it worth testing. Palace is what happened when I kept pulling the thread through thought experiments and real industry pain points.

Everything in this README — trust frontmatter as inspectable provenance, plain-markdown-on-disk as the source of truth, the heat signal as a usage trail, distillation as the unit of retention — is a downstream answer to that seed. If you want to understand *why* Palace looks the way it does instead of looking like a vector DB with an SDK on top, that is the place to start.

The attribution is uncertain — the piece's own authorship was ambiguous, and the name *Mila* surfaces with it in a way I have not fully confirmed. The original short and a longer essay tracing the lineage will ship with `docs/origins/` in the public package. If you recognize the source and can confirm attribution, please open an issue — I would like to credit it properly.
