'use strict';

const fs    = require('fs');
const path  = require('path');
const trust = require('./scripts/palace-trust.js');
const paths = require('./scripts/palace-paths.js');

const PALACE_HOME = process.env.PALACE_HOME || path.join(process.env.HOME, '.palace');

// ── Helpers ─────────────────────────────────────────────────────────────────

function roomPath(wing, hall, id) {
  return path.join(PALACE_HOME, 'wings', wing, hall, `${id}.md`);
}

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

function parseRoom(content) {
  const lines = content.split('\n');
  const meta  = {};
  let bodyStart = 0;

  if (lines[0] === '---') {
    let i = 1;
    while (i < lines.length && lines[i] !== '---') {
      const colonIdx = lines[i].indexOf(': ');
      if (colonIdx !== -1) {
        meta[lines[i].slice(0, colonIdx).trim()] = lines[i].slice(colonIdx + 2).trim();
      }
      i++;
    }
    if (i >= lines.length) {
      // Closing --- was never found — treat entire content as body
      return { id: '', wing: '', hall: '', created: '', tags: [], body: content.trim() };
    }
    bodyStart = i + 1;
  }

  const rawTags = (meta.tags || '[]').replace(/[\[\]]/g, '');
  const tags    = rawTags ? rawTags.split(',').map(t => t.trim()).filter(Boolean) : [];

  return {
    id:      meta.id      || '',
    wing:    meta.wing    || '',
    hall:    meta.hall    || '',
    created: meta.created || '',
    tags,
    body: lines.slice(bodyStart).join('\n').trim(),
  };
}

function getAllWings() {
  const wingsDir = path.join(PALACE_HOME, 'wings');
  if (!fs.existsSync(wingsDir)) return [];
  return fs.readdirSync(wingsDir).filter(f =>
    fs.statSync(path.join(wingsDir, f)).isDirectory()
  );
}

function withIndexLock(fn) {
  const lockFile = path.join(PALACE_HOME, 'index', '.lock');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });

  const deadline = Date.now() + 5000;
  let acquired = false;
  while (Date.now() < deadline) {
    try {
      // O_EXCL ensures atomic creation — fails if file already exists
      const fd = fs.openSync(lockFile, 'wx');
      fs.closeSync(fd);
      acquired = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Lock held — wait 20ms and retry (synchronous busy-wait via Date loop)
      const wait = Date.now() + 20;
      while (Date.now() < wait) {} // eslint-disable-line no-empty
    }
  }
  if (!acquired) {
    throw new Error('Palace index lock timeout — could not acquire lock within 5s');
  }

  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lockFile); } catch {}
  }
}

function updateRecent(entry) {
  withIndexLock(() => {
    const recentFile = path.join(PALACE_HOME, 'index', 'recent.json');
    fs.mkdirSync(path.dirname(recentFile), { recursive: true });

    let recent = [];
    if (fs.existsSync(recentFile)) {
      try { recent = JSON.parse(fs.readFileSync(recentFile, 'utf8')); } catch {}
    }

    recent.unshift(entry);
    recent = recent.slice(0, 50);
    writeAtomic(recentFile, JSON.stringify(recent, null, 2));
  });
}

function updateIndex(wing, hall, id, tags) {
  withIndexLock(() => {
    const indexFile = path.join(PALACE_HOME, 'index', 'keyword-index.json');
    fs.mkdirSync(path.dirname(indexFile), { recursive: true });

    let index = {};
    if (fs.existsSync(indexFile)) {
      try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch {}
    }

    for (const tag of tags) {
      if (!index[tag]) index[tag] = [];
      const alreadyIndexed = index[tag].some(e => e.id === id);
      if (!alreadyIndexed) {
        index[tag].push({ wing, hall, id });
      }
    }

    writeAtomic(indexFile, JSON.stringify(index, null, 2));
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

function isDuplicate(wing, hall, body) {
  const hallDir = path.join(PALACE_HOME, 'wings', wing, hall);
  if (!fs.existsSync(hallDir)) return false;
  const prefix = body.slice(0, 80).toLowerCase();
  for (const file of fs.readdirSync(hallDir).filter(f => f.endsWith('.md'))) {
    const existing = parseRoom(fs.readFileSync(path.join(hallDir, file), 'utf8'));
    if (existing.body.slice(0, 80).toLowerCase() === prefix) return true;
  }
  return false;
}

async function store(wing, hall, body, tags = [], opts = {}) {
  // ── v2.1 trust pipeline — no silent fallbacks ──
  const trustLevel = trust.normalizeTrust(opts.trust);   // null if missing/invalid → quarantines
  const source     = opts.source || null;                 // null if missing → quarantines
  const ephemeral  = !!opts.ephemeral;
  const expiresAt  = ephemeral ? trust.expiryFromTtl(opts.ttlDays) : null;

  const sanitized       = trust.sanitizeSecrets(body);
  const safeBody        = sanitized.text;
  const redactedSecrets = sanitized.hits;

  const injection      = trust.detectInjection(safeBody);
  const reviewRequired = opts.review_required === true || injection.flagged || trustLevel === 'low';

  if (isDuplicate(wing, hall, safeBody)) {
    const existing = await recall(wing, hall, { limit: 1 });
    return existing[0]
      ? { id: existing[0].id, wing, hall, duplicate: true, redactedSecrets, injectionPatterns: injection.patterns }
      : { id: 'dup', wing, hall, duplicate: true, redactedSecrets, injectionPatterns: injection.patterns };
  }

  const id      = `r-${Date.now()}`;
  const created = new Date().toISOString().slice(0, 10);

  // Build the record shape defaultVisibility() expects.
  const record = {
    id, wing, hall,
    trust:           trustLevel,
    source,
    review_required: reviewRequired,
    archived:        false,
  };

  const finalPath = paths.pathForRecord(record);
  const visibility = paths.defaultVisibility(record);

  const lines = [
    '---',
    `id: ${id}`,
    `wing: ${wing}`,
    `hall: ${hall}`,
    `created: ${created}`,
    `tags: [${tags.join(', ')}]`,
  ];
  if (trustLevel)             lines.push(`trust: ${trustLevel}`);
  if (source)                 lines.push(`source: ${source}`);
  if (ephemeral)              lines.push(`ephemeral: true`, `expires_at: ${expiresAt}`);
  if (reviewRequired)         lines.push(`review_required: true`);
  if (injection.flagged)      lines.push(`injection_patterns: [${injection.patterns.join(', ')}]`);
  if (redactedSecrets.length) lines.push(`redacted_secrets: [${[...new Set(redactedSecrets)].join(', ')}]`);
  lines.push('---', safeBody);
  const content = lines.join('\n');

  await paths.withWriteLock(async () => {
    paths.writeAtomic(finalPath, content);
  });

  updateIndex(wing, hall, id, tags);
  updateRecent({ id, wing, hall, body: safeBody.slice(0, 200), created, visibility });

  return {
    id, wing, hall,
    trust: trustLevel,
    source,
    visibility,
    ephemeral,
    expiresAt,
    reviewRequired,
    redactedSecrets,
    injectionPatterns: injection.patterns,
  };
}

async function recall(wing, hall, { limit = 10 } = {}) {
  const hallDir = path.join(PALACE_HOME, 'wings', wing, hall);
  if (!fs.existsSync(hallDir)) return [];

  return fs.readdirSync(hallDir)
    .filter(f => f.endsWith('.md'))
    .map(f => parseRoom(fs.readFileSync(path.join(hallDir, f), 'utf8')))
    .sort((a, b) => {
      const ca = a.created || '0000-00-00';
      const cb = b.created || '0000-00-00';
      if (cb !== ca) return cb.localeCompare(ca);
      // Tiebreak by ID (r-{timestamp}) for intra-day ordering
      return (b.id || '').localeCompare(a.id || '');
    })
    .slice(0, limit);
}

async function search(query, { wings = [], includeSessions = false } = {}) {
  const terms       = query.toLowerCase().split(/\s+/).filter(Boolean);
  const searchWings = wings.length ? wings : getAllWings();
  const results     = [];
  const seen        = new Set();

  // Fast path: use keyword index for terms that are indexed
  const indexFile = path.join(PALACE_HOME, 'index', 'keyword-index.json');
  let index = {};
  if (fs.existsSync(indexFile)) {
    try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch {}
  }

  const indexedTerms   = terms.filter(t => index[t]);
  const unindexedTerms = terms.filter(t => !index[t]);

  if (indexedTerms.length > 0 && unindexedTerms.length === 0) {
    // All terms are indexed — use index for candidate set
    // Intersect: room must appear in ALL indexed terms
    const candidateSets = indexedTerms.map(t =>
      new Set(index[t].filter(e => !wings.length || wings.includes(e.wing)).map(e => `${e.wing}|${e.hall}|${e.id}`))
    );
    const intersection = [...candidateSets[0]].filter(key => candidateSets.every(s => s.has(key)));

    for (const key of intersection) {
      const [wing, hall, id] = key.split('|');
      const roomFile = path.join(PALACE_HOME, 'wings', wing, hall, `${id}.md`);
      if (!fs.existsSync(roomFile)) continue;
      const room = parseRoom(fs.readFileSync(roomFile, 'utf8'));
      // Verify full-text match (tags may match but body query should too)
      const text = `${room.body} ${room.tags.join(' ')}`.toLowerCase();
      if (terms.every(t => text.includes(t)) && !seen.has(id)) {
        seen.add(id);
        results.push(room);
      }
    }
  } else {
    // Unindexed terms present — full scan required
    for (const wing of searchWings) {
      const wingDir = path.join(PALACE_HOME, 'wings', wing);
      if (!fs.existsSync(wingDir)) continue;
      for (const hall of fs.readdirSync(wingDir)) {
        const hallDir = path.join(wingDir, hall);
        if (!fs.statSync(hallDir).isDirectory()) continue;
        for (const file of fs.readdirSync(hallDir).filter(f => f.endsWith('.md'))) {
          const room = parseRoom(fs.readFileSync(path.join(hallDir, file), 'utf8'));
          const text = `${room.body} ${room.tags.join(' ')}`.toLowerCase();
          if (terms.every(t => text.includes(t)) && !seen.has(room.id)) {
            seen.add(room.id);
            results.push(room);
          }
        }
      }
    }
  }

  // Session search (optional, off by default)
  if (includeSessions) {
    const sessionsDir = path.join(PALACE_HOME, 'sessions');
    if (fs.existsSync(sessionsDir)) {
      for (const file of fs.readdirSync(sessionsDir).filter(f => f.endsWith('.md'))) {
        const room = parseRoom(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
        const text = `${room.body} ${room.tags.join(' ')}`.toLowerCase();
        if (terms.every(t => text.includes(t))) {
          results.push({ ...room, wing: 'sessions', hall: 'raw' });
        }
      }
    }
  }

  return results.sort((a, b) => {
    const ca = a.created || '0000-00-00';
    const cb = b.created || '0000-00-00';
    if (cb !== ca) return cb.localeCompare(ca);
    return (b.id || '').localeCompare(a.id || '');
  });
}

async function summary(limit = 20) {
  const recentFile = path.join(PALACE_HOME, 'index', 'recent.json');
  if (!fs.existsSync(recentFile)) return [];
  try {
    return JSON.parse(fs.readFileSync(recentFile, 'utf8')).slice(0, limit);
  } catch {
    return [];
  }
}

function updateRoom(wing, hall, id, { body, tags } = {}) {
  const filePath = roomPath(wing, hall, id);
  if (!fs.existsSync(filePath)) return null;

  const existing = parseRoom(fs.readFileSync(filePath, 'utf8'));
  const newBody  = body  !== undefined ? body  : existing.body;
  const newTags  = tags  !== undefined ? tags  : existing.tags;
  const oldTags  = existing.tags;

  const content = [
    '---',
    `id: ${id}`,
    `wing: ${wing}`,
    `hall: ${hall}`,
    `created: ${existing.created}`,
    `tags: [${newTags.join(', ')}]`,
    '---',
    newBody,
  ].join('\n');

  writeAtomic(filePath, content);

  // Update index atomically: remove stale tag entries, add new ones
  withIndexLock(() => {
    const indexFile = path.join(PALACE_HOME, 'index', 'keyword-index.json');
    fs.mkdirSync(path.dirname(indexFile), { recursive: true });
    let index = {};
    if (fs.existsSync(indexFile)) {
      try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch {}
    }

    // Remove room id from tags that were removed
    const removedTags = oldTags.filter(t => !newTags.includes(t));
    for (const tag of removedTags) {
      if (index[tag]) {
        index[tag] = index[tag].filter(e => e.id !== id);
        if (index[tag].length === 0) delete index[tag];
      }
    }

    // Add room id to new tags
    for (const tag of newTags) {
      if (!index[tag]) index[tag] = [];
      if (!index[tag].some(e => e.id === id)) {
        index[tag].push({ wing, hall, id });
      }
    }

    writeAtomic(indexFile, JSON.stringify(index, null, 2));
  });

  updateRecent({ id, wing, hall, body: newBody.slice(0, 200), created: existing.created });

  return { id, wing, hall };
}

async function getRoom(wing, hall, id) {
  const filePath = roomPath(wing, hall, id);
  if (!fs.existsSync(filePath)) return null;
  return parseRoom(fs.readFileSync(filePath, 'utf8'));
}

module.exports = { store, recall, search, summary, updateRoom, getRoom };
