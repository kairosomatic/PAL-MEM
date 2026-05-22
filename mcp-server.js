#!/usr/bin/env node
'use strict';

/**
 * mcp-server.js — PAL MCP server (Phase 3).
 *
 * Exposes Palace memory as MCP tools for Claude Code (and any MCP client).
 * Transport: stdio (JSON-RPC over stdin/stdout). The client spawns this as
 * a child process — no port to manage, no daemon required.
 *
 * Tools exposed:
 *   palace_bootstrap   — call at session start, returns ranked context bundle
 *   palace_recall      — hybrid search, returns top-K abstracts
 *   palace_search      — broader keyword/semantic query, supports wing/hall filter
 *   palace_remember    — write a new record (and asynchronously trigger abstract+embed)
 *   palace_forget      — soft-archive a record by ID
 *
 * Backed by direct import of palace-retrieval.js — no HTTP hop, one corpus
 * loaded into memory per Claude Code instance.
 */

const path = require('path');
const fs   = require('fs');

const { McpServer }            = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z }                    = require('zod');

const retrieval = require('./scripts/palace-retrieval.js');
const palace    = require('./palace.js');
const access    = require('./scripts/palace-access.js');

const PALACE_HOME = process.env.PALACE_HOME || path.join(process.env.HOME, '.palace');

// ─── Helpers ───────────────────────────────────────────────────────────────

function asText(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}

function asError(message) {
  return { isError: true, content: [{ type: 'text', text: `Error: ${message}` }] };
}

// ─── Server setup ──────────────────────────────────────────────────────────

const server = new McpServer({
  name:    'palace',
  version: '1.0.0',
});

server.registerTool(
  'palace_bootstrap',
  {
    title: 'Bootstrap Palace context for a project/branch',
    description:
      'Call at the start of a session to get a ranked context bundle from Palace memory: ' +
      'project records, recent sessions, recent episodics, relevant procedurals, and entities. ' +
      'Returns abstracts (~200 tokens each) bounded by maxTokens. Drops, never truncates.',
    inputSchema: {
      project:           z.string().optional().describe('Project name (typically the wing — e.g., "cardshop")'),
      branch:            z.string().optional().describe('Git branch — used to rank procedurals by relevance'),
      maxTokens:         z.number().int().positive().optional().describe('Token budget (default 2000)'),
      since:             z.string().optional().describe('ISO date — only include records updated since'),
      includeQuarantine: z.boolean().optional().describe('Include records under quarantine/ (default false). Quarantined = unstamped, trust=low, or review_required=true.'),
      includeLowTrust:   z.boolean().optional().describe('DEPRECATED — use includeQuarantine. Accepted for one release for backward compatibility.'),
    },
  },
  async (args) => {
    try {
      const bundle = await retrieval.bootstrap({
        project:           args.project,
        branch:            args.branch,
        maxTokens:         args.maxTokens || 2000,
        since:             args.since,
        includeQuarantine: !!(args.includeQuarantine || args.includeLowTrust),
      });
      return asText(bundle);
    } catch (e) { return asError(e.message); }
  },
);

server.registerTool(
  'palace_recall',
  {
    title: 'Hybrid recall against Palace memory',
    description:
      'Top-K records ranked by hybrid score (cosine + keyword + recency + access). ' +
      'Use when you need prior context relevant to a specific question.',
    inputSchema: {
      query: z.string().describe('Natural-language query'),
      k:     z.number().int().positive().optional().describe('Number of results (default 5)'),
      types: z.array(z.enum(['project', 'session', 'entity', 'procedural', 'episodic'])).optional()
              .describe('Restrict to specific memory types'),
      wing:  z.string().optional().describe('Restrict to a specific wing (e.g., "cardshop")'),
      hall:  z.string().optional().describe('Restrict to a specific hall'),
      since: z.string().optional().describe('ISO date — only include records updated since'),
      mode:  z.enum(['semantic', 'keyword', 'hybrid']).optional().describe('Default hybrid'),
      raw:   z.boolean().optional().describe('Include full body in result, not just abstract'),
      includeQuarantine: z.boolean().optional().describe('Include records under quarantine/ (default false).'),
      includeLowTrust:   z.boolean().optional().describe('DEPRECATED — use includeQuarantine. Accepted for one release.'),
    },
  },
  async (args) => {
    try {
      const hits = await retrieval.recall(args.query, {
        k:                 args.k || 5,
        types:             args.types,
        wing:              args.wing,
        hall:              args.hall,
        since:             args.since,
        mode:              args.mode || 'hybrid',
        raw:               !!args.raw,
        includeQuarantine: !!(args.includeQuarantine || args.includeLowTrust),
      });
      return asText({ query: args.query, k: hits.length, hits });
    } catch (e) { return asError(e.message); }
  },
);

server.registerTool(
  'palace_search',
  {
    title: 'Broad search across Palace memory',
    description:
      'Like palace_recall but returns more results and is intended for open-ended exploration. ' +
      'Same scoring, k defaults to 10.',
    inputSchema: {
      query: z.string().describe('Natural-language query'),
      k:     z.number().int().positive().optional().describe('Number of results (default 10)'),
      wing:  z.string().optional(),
      hall:  z.string().optional(),
      raw:   z.boolean().optional(),
      includeQuarantine: z.boolean().optional().describe('Include records under quarantine/ (default false).'),
      includeLowTrust:   z.boolean().optional().describe('DEPRECATED — use includeQuarantine. Accepted for one release.'),
    },
  },
  async (args) => {
    try {
      const hits = await retrieval.search(args.query, {
        k:                 args.k || 10,
        wing:              args.wing,
        hall:              args.hall,
        raw:               !!args.raw,
        includeQuarantine: !!(args.includeQuarantine || args.includeLowTrust),
      });
      return asText({ query: args.query, k: hits.length, hits });
    } catch (e) { return asError(e.message); }
  },
);

server.registerTool(
  'palace_remember',
  {
    title: 'Write a new record into Palace memory',
    description:
      'Call when you make a durable decision, discover a bug worth remembering, or complete a task. ' +
      'Body should be self-contained prose — future sessions will retrieve via abstract + embedding. ' +
      'Abstract and embedding are generated asynchronously by the next palace abstract/embed pass. ' +
      'Trust + ephemeral options apply Phase 4 protections: secrets are redacted before write, ' +
      'prompt-injection patterns auto-flag review_required, low-trust records are excluded from ' +
      'bootstrap by default, ephemeral records auto-archive after ttlDays.',
    inputSchema: {
      wing:      z.string().describe('Wing (top-level project namespace, e.g., "cardshop", "axel", "research")'),
      hall:      z.string().describe('Hall (sub-namespace, e.g., "operations", "diary", "harness-engineering-notes")'),
      body:      z.string().min(20).describe('Self-contained prose. Lead with what + why; include key entities/files/decisions.'),
      tags:      z.array(z.string()).optional().describe('Free-form tags for filtering'),
      trust:     z.enum(['high', 'medium', 'low']).optional().describe('Trust level. Default high. Use "low" for any record sourced from untrusted input (email, scraped web, third-party).'),
      source:    z.string().optional().describe('Where this record came from — "agent", "user", "email:gmail", "scrape:tcgplayer", etc.'),
      ephemeral: z.boolean().optional().describe('If true, record auto-archives after ttlDays (default 7)'),
      ttlDays:   z.number().int().positive().optional().describe('Days until ephemeral expiry (default 7)'),
    },
  },
  async (args) => {
    try {
      const result = await palace.store(
        args.wing, args.hall, args.body, args.tags || [],
        {
          trust:     args.trust,
          source:    args.source,
          ephemeral: !!args.ephemeral,
          ttlDays:   args.ttlDays,
        },
      );
      // Trigger reload so the new record is searchable next call (without abstract/emb yet).
      process.nextTick(() => { try { retrieval.reload(); } catch {} });
      const warnings = [];
      if (result.injectionPatterns?.length) warnings.push(`prompt-injection patterns matched: ${result.injectionPatterns.join(', ')} → review_required=true`);
      if (result.redactedSecrets?.length)   warnings.push(`secrets redacted: ${[...new Set(result.redactedSecrets)].join(', ')}`);
      if (result.visibility === 'quarantine') warnings.push(`record routed to quarantine/ (trust=${result.trust ?? '<unstamped>'}, review_required=${!!result.reviewRequired}) — excluded from bootstrap by default; use \`palace promote --id ${result.id} --reason "..."\` to publish`);
      else if (result.trust === 'low')      warnings.push('record stored with trust=low — excluded from bootstrap by default');
      if (result.ephemeral)                 warnings.push(`ephemeral — expires ${result.expiresAt}`);
      return asText({
        ok: true,
        ...result,
        warnings,
        note: 'Abstract + embedding will be generated by the next palace abstract/embed pass',
      });
    } catch (e) { return asError(e.message); }
  },
);

server.registerTool(
  'palace_forget',
  {
    title: 'Soft-archive a Palace record by ID',
    description:
      'Moves the record (and its .emb sidecar) to ~/.palace/archive/. ' +
      'Reversible by hand if you need to restore. Does not break git history.',
    inputSchema: {
      id: z.string().describe('Record ID, e.g., "r-1778213527065"'),
    },
  },
  async (args) => {
    try {
      const found = retrieval.corpus.find(r => r.id === args.id);
      if (!found) return asError(`Record not found: ${args.id}`);

      const archiveDir = path.join(PALACE_HOME, 'archive', found.wing, found.hall);
      fs.mkdirSync(archiveDir, { recursive: true });
      const archivePath = path.join(archiveDir, found.file);

      fs.renameSync(found.fullPath, archivePath);
      const embPath = found.fullPath.replace(/\.md$/, '.emb');
      if (fs.existsSync(embPath)) {
        fs.renameSync(embPath, archivePath.replace(/\.md$/, '.emb'));
      }

      retrieval.reload();
      return asText({ ok: true, archivedTo: archivePath });
    } catch (e) { return asError(e.message); }
  },
);

server.registerTool(
  'palace_stats',
  {
    title: 'Stats about Palace corpus',
    description: 'Returns total records, breakdown by wing/type, and access leaders.',
    inputSchema: {},
  },
  async () => {
    try { return asText(retrieval.stats()); }
    catch (e) { return asError(e.message); }
  },
);

// ─── Lifecycle ─────────────────────────────────────────────────────────────

async function main() {
  retrieval.load();
  // Periodic reload so the MCP server picks up new writes from the CLI / pal-server / other processes
  const reloadHandle = setInterval(() => {
    try { retrieval.reload(); } catch {}
  }, 60000);
  reloadHandle.unref();

  // Access counter flush timer
  access.start(30000);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Important: McpServer logs to stderr, never stdout (stdout is the JSON-RPC channel).
  process.stderr.write('[palace-mcp] connected via stdio\n');

  const shutdown = () => {
    process.stderr.write('[palace-mcp] shutting down\n');
    try { access.stop(); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT',  shutdown);
}

main().catch(e => {
  process.stderr.write(`[palace-mcp] fatal: ${e.message}\n`);
  process.exit(1);
});
