# PAL-MEM — Hermes Integration

> **Agent-readable.** This document is formatted for ingestion by a Hermes session or `palace_remember`. Follow the numbered steps exactly. All paths are literal — no substitution required on a standard Hermes install.

---

## What this integration does

Hermes uses PAL-MEM as its persistent memory backend. Every conversation turn that meets the flush threshold is stored as a Palace record. Every incoming query is pre-loaded with relevant Palace context before the model sees the user message. The operator can inspect, promote, demote, or quarantine any stored memory by reading the markdown files directly.

Integration surface: Hermes calls `~/.palace/palace-api.js` as a Node.js subprocess. No MCP server required for Hermes — the API bridge is the direct CLI.

---

## Prerequisites

- Node.js v18+ (`node --version`)
- npm
- Hermes installed and running (`~/.hermes/` directory exists, `config.yaml` present)

---

## Step 1 — Clone PAL-MEM to `~/.palace`

```bash
git clone https://github.com/kairosomatic/PAL-MEM ~/.palace
cd ~/.palace && npm install
```

The path `~/.palace` is required. Hermes resolves `palace-api.js` at `$HOME/.palace/palace-api.js` — no config override exists for the path.

Verify:

```bash
ls ~/.palace/palace-api.js
# /Users/<you>/.palace/palace-api.js
```

---

## Step 2 — Configure Hermes

Open `~/.hermes/config.yaml` and confirm or set:

```yaml
memory:
  memory_enabled: true
  provider: palace
  flush_min_turns: 6
  memory_char_limit: 2200
  nudge_interval: 10
  user_profile_enabled: true
  user_char_limit: 1375
```

`provider: palace` is the key line. If it reads `provider: local` or is absent, change it to `palace`.

---

## Step 3 — Verify the API bridge

```bash
node ~/.palace/palace-api.js search "test"
# Expected: [] or a JSON array of matching records
```

```bash
node ~/.palace/palace-api.js summary 5
# Expected: JSON summary of recent records
```

If either command errors, check that `npm install` completed without errors in `~/.palace/`.

---

## Step 4 — Bootstrap

```bash
node ~/.palace/palace-cli.js bootstrap --json
# Expected: { "loaded": N, "skipped": 0, "quarantined": 0, "warnings": [] }
```

On a fresh install `loaded` will be 0. That is correct.

---

## Step 5 — Restart Hermes

```bash
# If running as a process:
kill $(cat ~/.hermes/gateway.pid) && python ~/.hermes-bot/bot.py
```

On the next conversation turn, Hermes will call `palace_search` at turn start and `palace_store_bg` at flush intervals.

---

## How the integration works at runtime

**On each user message:**
1. Hermes calls `palace_call("search", user_text)` — returns top-N relevant records
2. If results exist, they are prepended to the system context as `[Palace context: ...]`
3. Model response is generated with that context loaded

**At flush intervals (every `flush_min_turns` turns):**
1. Hermes calls `palace_call("store", wing, hall, body)` — writes a new record
2. Record lands in `~/.palace/wings/<wing>/<hall>/r-<timestamp>.md`
3. Trust and injection audit run inline at write time

**Manual operations (from a Hermes session or terminal):**

```bash
# Search
node ~/.palace/palace-api.js search "query string"

# Store
node ~/.palace/palace-api.js store <wing> <hall> "body text"

# Recall by wing/hall
node ~/.palace/palace-api.js recall <wing> <hall>

# Summary of recent records
node ~/.palace/palace-api.js summary 10
```

---

## Inspect stored memories

All Hermes memories are plain markdown on disk:

```bash
ls ~/.palace/wings/                # list wings (topic areas)
ls ~/.palace/wings/<wing>/         # list halls under a wing
cat ~/.palace/wings/<wing>/<hall>/r-<id>.md   # read a specific record
```

Records flagged for review (injection pattern hit or low-trust source) land in:

```bash
ls ~/.palace/quarantine/wings/
```

---

## Troubleshooting

**Hermes responses have no Palace context**
- Check `memory_enabled: true` and `provider: palace` in config.yaml
- Run `node ~/.palace/palace-api.js search "recent"` manually — if it returns empty, the corpus is empty (correct on fresh install)
- Check `~/.hermes-bot/bot.log` for `palace_call failed` lines

**`palace-api.js` not found**
- PAL-MEM must be cloned to `~/.palace` exactly — no custom path support in Hermes
- Run `ls ~/.palace/palace-api.js` to confirm

**Records not appearing after flush**
- Hermes flushes after `flush_min_turns` turns (default 6) — have at least 6 turns in the session
- Check `~/.hermes-bot/bot.log` for `palace_store_bg failed` lines
- Run `node ~/.palace/palace-cli.js stats --json` to see record count

---

## Related

- [README.md](../../README.md) — full PAL-MEM overview
- [INSTALL.md](../../INSTALL.md) — Claude Code / MCP install path
- Palace spec for Hermes: `~/.hermes/specs/palace-agent-layer-spec-v1.md` (local, not in this repo)
