'use strict';

/**
 * palace-retrieval.js — Hybrid retrieval engine for PAL Phase 2.
 *
 * Loads all .emb sidecars + frontmatter into memory once at startup, then
 * answers recall/search/bootstrap queries against an in-memory corpus.
 * Reloads on a 60s timer (or via reload()).
 *
 * Hybrid score (per spec):
 *   score = 0.65 × cosine(query.emb, record.emb)
 *         + 0.20 × keyword_overlap(lemmas(query), record.keywords)
 *         + 0.10 × recency_decay(record.updated_at)
 *         + 0.05 × log(1 + record.access.total)
 *
 * Public API:
 *   load()                       — eager scan of all wings/halls/rooms
 *   reload()                     — re-scan (called periodically)
 *   recall(query, opts)          — hybrid top-K
 *   search(query, opts)          — broader, allows wing/hall filter
 *   bootstrap(opts)              — token-budgeted context bundle
 *   embedQuery(text)             — calls Ollama to embed a query string
 *   inferType(wing, hall)        — maps wing/hall to MemoryType
 *   stats()                      — corpus stats for /health and /stats
 */

const fs       = require('fs');
const path     = require('path');
const http     = require('http');
const natural  = require('natural');
const access   = require('./palace-access.js');
const trust    = require('./palace-trust.js');
const paths    = require('./palace-paths.js');

const PALACE_HOME = process.env.PALACE_HOME || path.join(process.env.HOME, '.palace');
const PUBLISHED_DIR  = paths.ROOTS.published;
const QUARANTINE_DIR = paths.ROOTS.quarantine;
const OLLAMA_URL  = process.env.OLLAMA_HOST || 'http://localhost:11434';
const EMBED_MODEL = process.env.PALACE_EMBED_MODEL || 'nomic-embed-text';

const STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being',
  'of','in','on','at','to','for','with','from','by',
  'this','that','these','those','and','or','but','not','no',
  'i','it','its','as','if','so','do','does','did','done',
  'have','has','had','can','could','will','would','should',
  'we','you','he','she','they','them','our','your','their',
  'my','me','us',
]);

const stemmer = natural.PorterStemmer;

const TYPE_MAP = [
  { match: /^cardshop\/operations$/,            type: 'episodic'   },
  { match: /^cardshop\//,                       type: 'project'    },
  { match: /^discord\/(council|daily)/,         type: 'session'    },
  { match: /^axel\/diary/,                      type: 'session'    },
  { match: /^research\//,                       type: 'procedural' },
  { match: /^qa-library\//,                     type: 'procedural' },
  { match: /^ai-stack\//,                       type: 'entity'     },
  { match: /^nexus\//,                          type: 'episodic'   },
  { match: /^meta\//,                           type: 'project'    },
];

let CORPUS = [];          // [{ id, wing, hall, file, fullPath, meta, body, keywords, vec, updated, type }]
let LOADED_AT = 0;

function tokenize(text) {
  return (text || '').toLowerCase().match(/[a-z][a-z0-9_-]{1,}/g) || [];
}

function lemmasOf(text) {
  const out = new Set();
  for (const tok of tokenize(text)) {
    if (STOP_WORDS.has(tok)) continue;
    if (tok.length < 3) continue;
    out.add(stemmer.stem(tok));
  }
  return out;
}

function parseFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { meta: {}, body: text };
  const meta = {};
  let i = 1;
  let multilineKey = null;
  let multilineValue = [];
  while (i < lines.length && lines[i] !== '---') {
    const line = lines[i];
    if (multilineKey !== null) {
      if (line.startsWith('  ') || line === '') {
        multilineValue.push(line.replace(/^ {2}/, ''));
        i++;
        continue;
      } else {
        meta[multilineKey] = multilineValue.join('\n').trim();
        multilineKey = null;
        multilineValue = [];
      }
    }
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) { i++; continue; }
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (val === '|' || val === '>') { multilineKey = key; multilineValue = []; }
    else meta[key] = val;
    i++;
  }
  if (multilineKey !== null) meta[multilineKey] = multilineValue.join('\n').trim();
  if (i >= lines.length) return { meta: {}, body: text };
  return { meta, body: lines.slice(i + 1).join('\n') };
}

function inferType(wing, hall) {
  const key = `${wing}/${hall}`;
  for (const rule of TYPE_MAP) {
    if (rule.match.test(key)) return rule.type;
  }
  return 'episodic';
}

function readEmb(embPath) {
  const buf = fs.readFileSync(embPath);
  const dim = buf.length / 4;
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function recencyDecay(updatedAt) {
  if (!updatedAt) return 0;
  const t = new Date(updatedAt).getTime();
  if (Number.isNaN(t)) return 0;
  const ageDays = (Date.now() - t) / 86400000;
  // Half-life ~30 days: decay = 2 ^ (-age/30)
  return Math.pow(2, -ageDays / 30);
}

function loadTree(rootDir, pathVisibility) {
  // Walk wings/<wing>/<hall>/<id>.md under the given root.
  // Tag each record with its path-implied visibility, but verify per-record
  // via defaultVisibility() — if frontmatter and path disagree, we skip the
  // record and warn to stderr (Kairos: pre-read enforcement closes the
  // store/doctor window for path drift).
  const out = [];
  if (!fs.existsSync(rootDir)) return out;

  for (const wing of fs.readdirSync(rootDir)) {
    const wingDir = path.join(rootDir, wing);
    let s; try { s = fs.statSync(wingDir); } catch { continue; }
    if (!s.isDirectory()) continue;

    for (const hall of fs.readdirSync(wingDir)) {
      const hallDir = path.join(wingDir, hall);
      let hs; try { hs = fs.statSync(hallDir); } catch { continue; }
      if (!hs.isDirectory()) continue;

      for (const file of fs.readdirSync(hallDir)) {
        if (!file.endsWith('.md')) continue;
        const fullPath = path.join(hallDir, file);

        let text;
        try { text = fs.readFileSync(fullPath, 'utf8'); } catch { continue; }
        const { meta, body } = parseFrontmatter(text);
        const id = meta.id || path.basename(file, '.md');

        // Per-record enforcement: compute current visibility from frontmatter.
        // If a record lives under wings/ but its frontmatter now says
        // quarantine (e.g. trust was changed in vim, promote/demote lagged),
        // skip it from the published view.
        const recordForVis = {
          id,
          wing,
          hall,
          trust:           meta.trust || null,
          source:          meta.source || null,
          review_required: meta.review_required === 'true',
          archived:        meta.archived === 'true',
        };
        const computedVis = paths.defaultVisibility(recordForVis);
        if (computedVis !== pathVisibility) {
          process.stderr.write(`palace-retrieval: ${id} under ${pathVisibility}/ but frontmatter visibility=${computedVis} — skipped\n`);
          continue;
        }

        // Skip expired ephemeral records — sweep should have caught these,
        // but retrieval enforces the rule even if sweep hasn't run yet.
        if (trust.isExpired({ meta })) continue;

        const embPath = fullPath.replace(/\.md$/, '.emb');
        let vec = null;
        if (fs.existsSync(embPath)) {
          try { vec = readEmb(embPath); } catch {}
        }

        const updated = meta.abstract_at || meta.created || null;
        const keywords = lemmasOf([meta.tags, meta.abstract, body].filter(Boolean).join(' '));

        out.push({
          id,
          wing,
          hall,
          file,
          fullPath,
          meta,
          body,
          abstract: meta.abstract || '',
          keywords,
          vec,
          updated,
          type:           inferType(wing, hall),
          visibility:     pathVisibility,
          trust:          meta.trust || null,
          source:         meta.source || null,
          ephemeral:      meta.ephemeral === 'true',
          expiresAt:      meta.expires_at || null,
          reviewRequired: meta.review_required === 'true',
        });
      }
    }
  }
  return out;
}

function load() {
  const t0 = Date.now();
  // Both trees always loaded; filtering by visibility happens at query time.
  // Cheap walk; ~1k records is fine; saves us a reload when caller flips
  // includeQuarantine.
  const corpus = [
    ...loadTree(PUBLISHED_DIR,  'published'),
    ...loadTree(QUARANTINE_DIR, 'quarantine'),
  ];

  CORPUS = corpus;
  LOADED_AT = Date.now();
  const dt = ((Date.now() - t0) / 1000).toFixed(2);
  return {
    count: corpus.length,
    published:  corpus.filter(r => r.visibility === 'published').length,
    quarantine: corpus.filter(r => r.visibility === 'quarantine').length,
    withEmb:    corpus.filter(r => r.vec).length,
    durationSec: dt,
  };
}

function reload() { return load(); }

function ollamaEmbed(text) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ model: EMBED_MODEL, prompt: text });
    const url  = new URL('/api/embeddings', OLLAMA_URL);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', c => (buf += c));
        res.on('end', () => {
          try {
            const obj = JSON.parse(buf);
            if (obj.error) return reject(new Error(obj.error));
            if (!Array.isArray(obj.embedding)) return reject(new Error('no embedding'));
            const v = new Float32Array(obj.embedding.length);
            for (let i = 0; i < obj.embedding.length; i++) v[i] = obj.embedding[i];
            resolve(v);
          } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Ollama embed timeout (15s)')));
    req.write(data);
    req.end();
  });
}

async function embedQuery(text) {
  return ollamaEmbed(text);
}

function lemmaOverlap(qLemmas, rLemmas) {
  if (!qLemmas.size || !rLemmas.size) return 0;
  let hits = 0;
  for (const t of qLemmas) if (rLemmas.has(t)) hits++;
  return hits / qLemmas.size;
}

function scoreRecord(record, qVec, qLemmas) {
  const cos = qVec && record.vec ? Math.max(0, cosine(qVec, record.vec)) : 0;
  const kw  = lemmaOverlap(qLemmas, record.keywords);
  const rec = recencyDecay(record.updated);
  const ac  = access.get(record.id);
  const acScore = Math.log(1 + (ac.total || 0)) / 5; // normalize: log(1+150)/5 ≈ 1
  return {
    score: 0.65 * cos + 0.20 * kw + 0.10 * rec + 0.05 * Math.min(1, acScore),
    components: { cos, kw, rec, ac: acScore },
  };
}

async function recall(query, opts = {}) {
  if (!CORPUS.length) load();
  const k       = opts.k || 5;
  const types   = opts.types || null;
  const wing    = opts.wing || null;
  const hall    = opts.hall || null;
  const since   = opts.since ? new Date(opts.since).getTime() : null;
  const mode    = opts.mode || 'hybrid';

  let qVec = null;
  if (mode !== 'keyword') {
    try { qVec = await embedQuery(query); } catch (e) {
      if (mode === 'semantic') throw e;
    }
  }
  const qLemmas = lemmasOf(query);

  // v2.1: filter by visibility, not trust. includeLowTrust kept as a one-release
  // backward-compat alias — callers that knew the old filter still work.
  const includeQuarantine = !!(opts.includeQuarantine || opts.includeLowTrust);
  const candidates = CORPUS.filter(r => {
    if (!includeQuarantine && r.visibility === 'quarantine') return false;
    if (types && !types.includes(r.type)) return false;
    if (wing && r.wing !== wing) return false;
    if (hall && r.hall !== hall) return false;
    if (since && r.updated && new Date(r.updated).getTime() < since) return false;
    if (mode === 'semantic' && !r.vec) return false;
    return true;
  });

  const scored = candidates.map(r => {
    const s = scoreRecord(r, qVec, qLemmas);
    return { ...s, record: r };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, k);

  for (const t of top) access.record(t.record.id, opts.accessType || 'recall');

  return top.map(t => formatHit(t, opts));
}

async function search(query, opts = {}) {
  return recall(query, { ...opts, k: opts.k || 10, accessType: 'search' });
}

function formatHit({ score, components, record }, opts = {}) {
  const prefix   = trust.displayPrefix(record.meta);
  const baseAbs  = record.abstract || record.body.slice(0, 200);
  const out = {
    id: record.id,
    wing: record.wing,
    hall: record.hall,
    type: record.type,
    score: Number(score.toFixed(4)),
    components: {
      cos: Number(components.cos.toFixed(4)),
      kw:  Number(components.kw.toFixed(4)),
      rec: Number(components.rec.toFixed(4)),
      ac:  Number(components.ac.toFixed(4)),
    },
    abstract: prefix + baseAbs,
    rawPath: record.fullPath,
    updated: record.updated,
    visibility:     record.visibility,
    source:         record.source,
    trust:          record.trust,
    reviewRequired: record.reviewRequired,
  };
  if (record.ephemeral) out.ephemeral = true;
  if (record.expiresAt) out.expiresAt = record.expiresAt;
  if (opts.raw) out.body = record.body;
  return out;
}

function approxTokens(s) {
  return Math.ceil((s || '').length / 4);
}

async function bootstrap(opts = {}) {
  if (!CORPUS.length) load();
  const project   = opts.project || null;
  const branch    = opts.branch || null;
  const maxTokens = opts.maxTokens || 2000;
  const since     = opts.since ? new Date(opts.since).getTime() : null;

  // Project-scoped filter: include only records whose wing matches project,
  // unless project is null (cross-project bootstrap).
  const projectMatch = (r) => !project || r.wing === project ||
    (project === 'cardshop' && (r.wing === 'cardshop' || r.wing === 'meta'));

  const inWindow = (r) => !since || (r.updated && new Date(r.updated).getTime() >= since);

  // Ranking buckets per spec:
  // 1. project records (always)
  // 2. recent session records for branch
  // 3. recent episodic (last 30 days)
  // 4. procedural matched by branch/topic
  // 5. entity referenced
  // tiebreaker: access.total desc

  // Bootstrap NEVER includes quarantine records by default — they'd contaminate
  // the auto-loaded session context. Caller can opt in with includeQuarantine
  // (or the legacy includeLowTrust alias).
  const includeQuarantine = !!(opts.includeQuarantine || opts.includeLowTrust);
  const filtered = CORPUS.filter(r =>
    projectMatch(r) &&
    inWindow(r) &&
    (includeQuarantine || r.visibility !== 'quarantine'),
  );

  const buckets = {
    project:    [],
    session:    [],
    episodic:   [],
    procedural: [],
    entity:     [],
  };

  const thirtyDaysAgo = Date.now() - 30 * 86400000;
  for (const r of filtered) {
    if (r.type === 'project') buckets.project.push(r);
    else if (r.type === 'session') buckets.session.push(r);
    else if (r.type === 'episodic' && r.updated && new Date(r.updated).getTime() >= thirtyDaysAgo) {
      buckets.episodic.push(r);
    } else if (r.type === 'procedural') buckets.procedural.push(r);
    else if (r.type === 'entity') buckets.entity.push(r);
  }

  const tieBreak = (a, b) => {
    const ua = a.updated ? new Date(a.updated).getTime() : 0;
    const ub = b.updated ? new Date(b.updated).getTime() : 0;
    if (ub !== ua) return ub - ua;
    return (access.get(b.id).total || 0) - (access.get(a.id).total || 0);
  };
  for (const k of Object.keys(buckets)) buckets[k].sort(tieBreak);

  // Optional: rank procedural by cosine to branch name + recent session topics
  if (branch && buckets.procedural.length) {
    try {
      const qVec = await embedQuery(branch);
      buckets.procedural = buckets.procedural
        .map(r => ({ r, c: r.vec ? cosine(qVec, r.vec) : 0 }))
        .sort((a, b) => b.c - a.c)
        .map(x => x.r);
    } catch { /* leave as-is on Ollama failure */ }
  }

  // Pull in priority order until budget exhausted
  const order = ['project', 'session', 'episodic', 'procedural', 'entity'];
  const targetCounts = { project: 10, session: 5, episodic: 5, procedural: 5, entity: 5 };
  const picked = [];
  let tokens = 0;

  for (const bk of order) {
    let cnt = 0;
    for (const r of buckets[bk]) {
      if (cnt >= targetCounts[bk]) break;
      const cost = approxTokens(r.abstract || '') + 30;
      if (tokens + cost > maxTokens) continue;
      picked.push({ bucket: bk, record: r });
      tokens += cost;
      cnt++;
    }
  }

  // Record access for everything we returned
  for (const p of picked) access.record(p.record.id, 'bootstrap');

  const formatted = picked.map(p => {
    const prefix = trust.displayPrefix(p.record.meta);
    return {
      id: p.record.id,
      wing: p.record.wing,
      hall: p.record.hall,
      type: p.record.type,
      bucket: p.bucket,
      abstract: prefix + (p.record.abstract || p.record.body.slice(0, 200)),
      rawPath: p.record.fullPath,
      updated: p.record.updated,
      visibility:     p.record.visibility,
      source:         p.record.source,
      trust:          p.record.trust,
      reviewRequired: p.record.reviewRequired,
    };
  });

  const rawPaths = {};
  for (const f of formatted) rawPaths[f.id] = f.rawPath;

  return {
    project: { name: project, branch },
    items: formatted,
    counts: {
      project: formatted.filter(f => f.bucket === 'project').length,
      session: formatted.filter(f => f.bucket === 'session').length,
      episodic: formatted.filter(f => f.bucket === 'episodic').length,
      procedural: formatted.filter(f => f.bucket === 'procedural').length,
      entity: formatted.filter(f => f.bucket === 'entity').length,
    },
    rawPaths,
    tokenCount: tokens,
    maxTokens,
  };
}

function stats() {
  if (!CORPUS.length) load();
  const byWing = {};
  const byType = {};
  let withEmb = 0;
  let withAbstract = 0;
  let lowTrust = 0;
  let reviewPending = 0;
  let ephemeralLive = 0;
  let published = 0;
  let quarantine = 0;
  for (const r of CORPUS) {
    byWing[r.wing] = (byWing[r.wing] || 0) + 1;
    byType[r.type] = (byType[r.type] || 0) + 1;
    if (r.vec) withEmb++;
    if (r.abstract) withAbstract++;
    if (r.trust === 'low') lowTrust++;
    if (r.reviewRequired)  reviewPending++;
    if (r.ephemeral)       ephemeralLive++;
    if (r.visibility === 'published')  published++;
    if (r.visibility === 'quarantine') quarantine++;
  }
  const accessStats = access.stats();
  return {
    totalRecords: CORPUS.length,
    withAbstract,
    withEmb,
    byWing,
    byType,
    visibility: { published, quarantine },
    trust: { lowTrust, reviewPending, ephemeralLive },
    loadedAt: new Date(LOADED_AT).toISOString(),
    access: {
      withAtLeastOneAccess: accessStats.totalAccessed,
      cold: accessStats.cold,
      hot: accessStats.hot,
    },
  };
}

module.exports = {
  load,
  reload,
  recall,
  search,
  bootstrap,
  embedQuery,
  inferType,
  cosine,
  lemmasOf,
  stats,
  get corpus() { return CORPUS; },
  get loadedAt() { return LOADED_AT; },
};
