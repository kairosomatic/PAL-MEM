# PAL-MEM — Palace Agent Layer

**Agent memory that your agent trusts, your tools can verify, and you can inspect with `grep`.**

PAL-MEM is a local-first memory system for AI agents. Every record is a plain markdown file with trust metadata, provenance, and a prompt-injection audit baked in. Agents retrieve against distilled records — not raw transcripts — so large corpora stay practical at small-model cost.

---

## Who this is for

| You are... | Start here |
|---|---|
| A developer wiring PAL-MEM into a project | [`README.technical.md`](./README.technical.md) |
| An agent or AI tool ingesting this repo | [`README.agent.md`](./README.agent.md) |
| Just evaluating whether PAL-MEM fits your stack | Keep reading this page |

---

## What it does in one paragraph

You run frontier AI sessions that produce useful synthesis — decisions, frames, distillations, research. Right now that cognitive work lives in a chat window and evaporates when the session ends. PAL-MEM gives it a home: a local store of short, distilled records that any agent can retrieve, any operator can audit with `cat`, and any session can bootstrap from. Records carry trust metadata so untrusted content never auto-loads into an agent session. The system has been in continuous operation at ~4M-token corpus scale — well past what any single model can hold natively.

---

## Compatibility

| Tool | Status | Notes |
|---|---|---|
| **Claude Code** | ✅ Native | MCP stdio server — `claude mcp add palace ~/.palace/mcp-server.js` |
| **Hermes** | ✅ Native | `provider: palace` in `~/.hermes/config.yaml` — see [`docs/integrations/hermes.md`](./docs/integrations/hermes.md) |
| **OpenClaw** | ✅ Compatible | OpenClaw spawns Claude Code sessions; Palace MCP loads automatically per those sessions |
| **Ollama** | ✅ Compatible | Ollama is a model runner, not a memory store — PAL-MEM works alongside it; Hermes uses both together |
| **LangChain / LangGraph** | ⚠️ Manual | No native adapter yet; call `palace recall --query "..." --json` from a tool node |
| **Mem0** | ⚠️ See migration | Different memory philosophy — migration requires re-authoring records from source sessions |
| **Letta / MemGPT** | ⚠️ See migration | Letta stores agent state in SQLite; no automatic migration path |
| **Zep** | ⚠️ See migration | Zep v3 uses a temporal knowledge graph; export via Zep API + reformat |

---

## Migration guide

### Coming from Mem0

Mem0 extracts semantic facts and relationships into a graph + vector store. PAL-MEM stores distilled markdown records authored by a frontier model. **These are different philosophies — there is no automatic migration.**

What you can do:
- Export your Mem0 facts via the Mem0 API (`GET /v1/memory/`)
- Reformat each fact as a Palace record (YAML frontmatter + body)
- Import via `palace remember` or deposit directly into `~/.palace/wings/`

Expect manual curation. A Mem0 fact like `"User prefers Python"` needs to become a full record with trust level, source, and a body that provides useful context — not just a key-value pair.

### Coming from Letta / MemGPT

Letta stores archival memory in SQLite and in-context state in the agent's conversation window. **Neither is directly importable.**

What you can do:
- Query Letta's archival memory via the Letta API
- Export each memory block as plain text
- Deposit into Palace as records via `palace remember`

The in-context state (persona, human block, etc.) has no Palace equivalent — those are agent configuration, not memory records.

### Coming from Zep

Zep v3 uses Graphiti temporal knowledge graphs with fact validity windows. The graph structure is not compatible with Palace's flat record model.

What you can do:
- Export episodes and facts via the Zep REST API
- Convert each episode to a Palace record (date → `created`, episode text → body)
- Validity windows → use Palace's `trust` and `review_required` frontmatter to flag uncertain facts

### Coming from vanilla RAG (ChromaDB, Pinecone, Weaviate, etc.)

**If your source documents still exist:** easiest migration. Re-run the distillation harness against your source corpus — Palace distills from the source, not from the embeddings.

**If your only record is the vector store:** you cannot reverse embeddings into text. You need the original source documents. If you don't have them, your migration options are limited to re-generating from scratch.

**Compressed or binary memory stores:** any memory in a binary format (SQLite blobs, proprietary exports) must be exported to plain text before Palace can work with it. Palace is markdown-native — no binary ingestion path exists.

### Coming from a custom agent memory system

If your memory is already in plain text or markdown: easiest path. Add YAML frontmatter to each file and drop into `~/.palace/wings/<wing>/<hall>/`. Palace reads any `.md` file with valid frontmatter.

**You do not have to move your files.** If you want to keep them at their current location, point Palace at that root instead of moving everything:

```json
{ "wingsPath": "/path/to/your/existing/notes" }
```

Save that to `~/.palace/config.json`. Alternatively, symlink your existing directory:

```bash
ln -s /path/to/your/existing/notes ~/.palace/wings
```

Embeddings are computed lazily on first retrieval or explicitly via `palace bootstrap`. They are stored as sidecar files alongside your records — your source files are never modified.

**One structural constraint:** Palace expects exactly two levels of subdirectory under `wingsPath`: `<wing>/<hall>/record.md`. Files nested deeper (e.g. `wing/hall/subfolder/record.md`) are ignored by the retrieval engine. If your existing system uses deeper nesting, flatten to two levels or use the top two levels as wing/hall and let deeper paths collapse.

Minimum valid frontmatter:
```yaml
---
id: r-<timestamp>
wing: <area>
hall: <subarea>
created: <YYYY-MM-DD>
trust: medium
source: operator
---
```

---

## Quick start

```bash
git clone https://github.com/kairosomatic/PAL-MEM ~/.palace
cd ~/.palace && npm install
claude mcp add palace ~/.palace/mcp-server.js
palace bootstrap --json
```

Full setup: [`INSTALL.md`](./INSTALL.md)

---

## The short version of the eval

On five public AI papers (~112K tokens), Haiku 4.5 with the PAL-MEM harness reached **98.3% of Opus 4.7's synthesis quality at ~12× lower cost**. The full methodology, rubric, and results are in [`docs/evals/eval-3-showcase.md`](./docs/evals/eval-3-showcase.md) — readable in the browser without installing.

---

## License

MIT. See [`LICENSE`](./LICENSE).
