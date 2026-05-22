#!/usr/bin/env node
'use strict';

/**
 * pal-server.js — PAL REST API (Phase 2).
 *
 * Local-only HTTP server, default port 7432.
 *
 *   POST   /bootstrap   { project, branch?, maxTokens?, since? }
 *   POST   /remember    { wing, hall, body, tags?, type?, ... }
 *   POST   /recall      { query, k?, types?, mode?, since?, raw? }
 *   GET    /search?q=&wing=&hall=&k=&raw=
 *   DELETE /forget/:id  (soft archive — moves record to archive/)
 *   GET    /health
 *   GET    /stats
 *
 * Run:
 *   node pal-server.js [--port 7432]
 *
 * No external dependencies (uses core http). Listens on 127.0.0.1 only.
 */

const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const url      = require('url');

const retrieval = require('./palace-retrieval.js');
const palace    = require('../palace.js');
const access    = require('./palace-access.js');

const PALACE_HOME = process.env.PALACE_HOME || path.join(process.env.HOME, '.palace');
const PORT  = parseInt(process.env.PAL_PORT || (process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '7432'), 10);
const HOST  = '127.0.0.1';

// ─── HTTP helpers ──────────────────────────────────────────────────────────

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control':  'no-store',
  });
  res.end(body);
}

function sendError(res, status, message, extra = {}) {
  sendJSON(res, status, { error: message, ...extra });
}

function readBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error(`Request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error(`Invalid JSON: ${e.message}`)); }
    });
    req.on('error', reject);
  });
}

// ─── Routes ────────────────────────────────────────────────────────────────

async function handleBootstrap(req, res) {
  const body = await readBody(req);
  const bundle = await retrieval.bootstrap({
    project:           body.project   || null,
    branch:            body.branch    || null,
    maxTokens:         body.maxTokens || 2000,
    since:             body.since     || null,
    includeQuarantine: !!(body.includeQuarantine || body.includeLowTrust),
  });
  sendJSON(res, 200, bundle);
}

async function handleRecall(req, res) {
  const body = await readBody(req);
  if (!body.query || typeof body.query !== 'string') {
    return sendError(res, 400, 'query (string) is required');
  }
  const hits = await retrieval.recall(body.query, {
    k:                 body.k     || 5,
    types:             Array.isArray(body.types) ? body.types : null,
    wing:              body.wing  || null,
    hall:              body.hall  || null,
    since:             body.since || null,
    mode:              body.mode  || 'hybrid',
    raw:               !!body.raw,
    includeQuarantine: !!(body.includeQuarantine || body.includeLowTrust),
  });
  sendJSON(res, 200, { query: body.query, k: hits.length, hits });
}

async function handleSearch(req, parsedUrl, res) {
  const q     = parsedUrl.query.q || parsedUrl.query.query;
  if (!q) return sendError(res, 400, 'q (query) parameter is required');
  const includeQuarantineParam =
    parsedUrl.query.includeQuarantine === 'true' || parsedUrl.query.includeQuarantine === '1' ||
    parsedUrl.query.includeLowTrust   === 'true' || parsedUrl.query.includeLowTrust   === '1';
  const hits = await retrieval.search(q, {
    k:                 parseInt(parsedUrl.query.k || '10', 10),
    wing:              parsedUrl.query.wing || null,
    hall:              parsedUrl.query.hall || null,
    raw:               parsedUrl.query.raw === 'true' || parsedUrl.query.raw === '1',
    includeQuarantine: includeQuarantineParam,
  });
  sendJSON(res, 200, { query: q, k: hits.length, hits });
}

async function handleRemember(req, res) {
  const body = await readBody(req);
  if (!body.wing || !body.hall) return sendError(res, 400, 'wing and hall are required');
  if (!body.body || typeof body.body !== 'string') return sendError(res, 400, 'body (string) is required');

  const tags = Array.isArray(body.tags) ? body.tags : [];
  const result = await palace.store(body.wing, body.hall, body.body, tags);

  // Schedule async abstract+embed so the write returns fast.
  // The next reload() will pick them up.
  process.nextTick(() => {
    try { retrieval.reload(); } catch {}
  });

  sendJSON(res, 200, { ok: true, ...result, note: 'Abstract+embed will be generated on next palace abstract/embed pass' });
}

async function handleForget(req, idParam, res) {
  // Soft archive: find the record, copy to archive/<wing>/<hall>/, remove original.
  // We don't delete the .emb here — palace doctor will flag the orphan and
  // a periodic sweep removes it. Simple, recoverable.
  const id = (idParam || '').trim();
  if (!id) return sendError(res, 400, 'id is required');

  const found = retrieval.corpus.find(r => r.id === id);
  if (!found) return sendError(res, 404, `Record not found: ${id}`);

  const archiveDir = path.join(PALACE_HOME, 'archive', found.wing, found.hall);
  fs.mkdirSync(archiveDir, { recursive: true });
  const archivePath = path.join(archiveDir, found.file);

  fs.renameSync(found.fullPath, archivePath);
  const embPath = found.fullPath.replace(/\.md$/, '.emb');
  if (fs.existsSync(embPath)) {
    fs.renameSync(embPath, archivePath.replace(/\.md$/, '.emb'));
  }

  retrieval.reload();
  sendJSON(res, 200, { ok: true, archivedTo: archivePath });
}

function handleHealth(res) {
  const s = retrieval.stats();
  sendJSON(res, 200, {
    status: 'ok',
    records: s.totalRecords,
    withAbstract: s.withAbstract,
    withEmb: s.withEmb,
    wings: Object.keys(s.byWing).length,
    loadedAt: s.loadedAt,
    uptimeSec: Math.round(process.uptime()),
  });
}

function handleStats(res) {
  sendJSON(res, 200, retrieval.stats());
}

// ─── Router ────────────────────────────────────────────────────────────────

async function router(req, res) {
  const parsedUrl = url.parse(req.url, true);
  const pathname  = parsedUrl.pathname;
  const method    = req.method;

  try {
    if (method === 'GET' && pathname === '/health')        return handleHealth(res);
    if (method === 'GET' && pathname === '/stats')         return handleStats(res);
    if (method === 'GET' && pathname === '/search')        return handleSearch(req, parsedUrl, res);
    if (method === 'POST' && pathname === '/bootstrap')    return handleBootstrap(req, res);
    if (method === 'POST' && pathname === '/recall')       return handleRecall(req, res);
    if (method === 'POST' && pathname === '/remember')     return handleRemember(req, res);
    if (method === 'DELETE' && pathname.startsWith('/forget/')) {
      return handleForget(req, decodeURIComponent(pathname.slice('/forget/'.length)), res);
    }
    sendError(res, 404, 'Not found', { method, pathname });
  } catch (e) {
    console.error(`[pal-server] ${method} ${pathname} →`, e.message);
    sendError(res, 500, e.message);
  }
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────

function start() {
  console.log('[pal-server] Loading corpus...');
  const loadStats = retrieval.load();
  console.log(`[pal-server] Loaded ${loadStats.count} records (${loadStats.withEmb} with embeddings) in ${loadStats.durationSec}s`);

  // Periodic reload — captures new writes from CLI/other processes
  const RELOAD_MS = 60000;
  const reloadHandle = setInterval(() => {
    try {
      const s = retrieval.reload();
      // Quiet log; only emit if count changed
    } catch (e) { console.error('[pal-server] reload error:', e.message); }
  }, RELOAD_MS);
  reloadHandle.unref();

  // Access counter flush timer — see palace-access.js
  access.start(30000);

  const server = http.createServer(router);
  server.listen(PORT, HOST, () => {
    console.log(`[pal-server] Listening on http://${HOST}:${PORT}`);
    console.log(`[pal-server]   GET  /health`);
    console.log(`[pal-server]   GET  /stats`);
    console.log(`[pal-server]   GET  /search?q=...`);
    console.log(`[pal-server]   POST /bootstrap`);
    console.log(`[pal-server]   POST /recall`);
    console.log(`[pal-server]   POST /remember`);
    console.log(`[pal-server]   DELETE /forget/:id`);
  });

  const shutdown = (signal) => {
    console.log(`[pal-server] ${signal} received, shutting down...`);
    server.close(() => {
      access.stop();
      process.exit(0);
    });
    // Force exit if it takes too long
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

if (require.main === module) start();

module.exports = { start };
