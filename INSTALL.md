# Palace Agent Layer (PAL) — Install Guide

## Prerequisites

- **Node.js** v18+ (`node --version`)
- **npm** (bundled with Node)
- **Claude Code** CLI (`claude --version`) — for MCP registration
- Git

---

## 1. Clone

```bash
git clone https://github.com/kairosomatic/PAL-MEM ~/.palace
cd ~/.palace
npm install
```

Palace lives at `~/.palace` by default. All internal paths resolve relative to this directory. If you clone elsewhere, set `PALACE_HOME` in your environment:

```bash
export PALACE_HOME=/path/to/your/palace
```

---

## 2. Register the MCP server with Claude Code

```bash
claude mcp add palace ~/.palace/mcp-server.js
```

This tells Claude Code to start the Palace MCP server on session launch. The server binds to stdio only — no ports opened.

Verify registration:

```bash
claude mcp list
# palace    ~/.palace/mcp-server.js    stdio
```

---

## 3. Add the CLI to your PATH (optional but recommended)

```bash
echo 'export PATH="$HOME/.palace:$PATH"' >> ~/.zshrc
source ~/.zshrc
palace --help
```

Without this step, call the CLI directly: `node ~/.palace/palace-cli.js <subcommand>`.

---

## 4. Verify with bootstrap

```bash
palace bootstrap --json
```

Expected output on a fresh install:

```json
{
  "loaded": 0,
  "skipped": 0,
  "quarantined": 0,
  "warnings": []
}
```

Zero records is correct — your corpus starts empty. The first frontier session deposit populates it.

---

## 5. Make your first deposit

From inside a Claude Code session (or any MCP client connected to Palace), call:

```
palace_remember
  wing: "work"
  hall: "decisions"
  body: "Your distilled record goes here."
  trust: "high"
  source: "claude-opus-4-7"
```

Then verify it landed:

```bash
palace stats --json
# { "total": 1, "byWing": { "work": 1 }, "quarantined": 0 }
```

---

## 6. Retrieve from a session

```bash
palace recall --query "what did we decide about X?" --json
```

Or via MCP tool in Claude Code:

```
palace_recall: { "query": "what did we decide about X?", "limit": 5 }
```

---

## Configuration

Palace reads `~/.palace/config.json` (created on first run if absent). Key fields:

| Field | Default | Description |
|---|---|---|
| `wingsPath` | `~/.palace/wings` | Root directory for published records |
| `quarantinePath` | `~/.palace/quarantine/wings` | Root for quarantined records |
| `defaultTrust` | `"medium"` | Trust level applied when not specified on deposit |
| `allowedSources` | `["claude-*", "operator"]` | Glob patterns for auto-trust allowlist |

---

## Troubleshooting

**`palace bootstrap` returns warnings about missing embeddings**
Embeddings are computed on first access. Run `palace bootstrap` once after a fresh clone to precompute — the second call will be silent.

**MCP server not connecting in Claude Code**
Check the registration path is absolute: `claude mcp list` should show the full path, not `~/`. If it shows `~/.palace/mcp-server.js`, remove and re-add with the expanded path:
```bash
claude mcp remove palace
claude mcp add palace /Users/<you>/.palace/mcp-server.js
```

**Records landing in quarantine unexpectedly**
Check frontmatter: `trust` must be `high` or `medium`, and `source` must match an entry in `allowedSources`. Run `palace stats --json` to see the quarantine count, then inspect with `ls ~/.palace/quarantine/wings/`.
