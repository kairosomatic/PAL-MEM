#!/usr/bin/env node
'use strict';

/**
 * palace-access.js — Access counter store for Palace records.
 *
 * Per PAL spec decision 5: counters live in a single JSON file, batched
 * to disk on a timer. This avoids rewriting every record's frontmatter
 * on every read.
 *
 * Public API:
 *   record(id, type)     — increment counter for a record (in-memory)
 *   get(id)              — read counter for a record
 *   flush()              — write in-memory counters to disk
 *   start(intervalMs)    — start auto-flush timer (returns handle)
 *   stop()               — stop auto-flush timer
 *   init()               — seed access.json with all existing records (idempotent)
 *   stats()              — { hot, cold, totalAccessed }
 *
 * CLI:
 *   palace-access.js init                  — seed counters for existing records
 *   palace-access.js record <id> <type>    — manual increment (for testing)
 *   palace-access.js stats                 — show top accessed + cold records
 */

const fs   = require('fs');
const path = require('path');

const PALACE_HOME = process.env.PALACE_HOME || path.join(process.env.HOME, '.palace');
const WINGS_DIR   = path.join(PALACE_HOME, 'wings');
const ACCESS_FILE = path.join(PALACE_HOME, 'index', 'access.json');

let cache = null;          // in-memory state
let dirty = false;         // has cache diverged from disk?
let timerHandle = null;

function load() {
  if (cache) return cache;
  if (!fs.existsSync(ACCESS_FILE)) {
    cache = {};
    return cache;
  }
  try { cache = JSON.parse(fs.readFileSync(ACCESS_FILE, 'utf8')); }
  catch { cache = {}; }
  return cache;
}

function flush() {
  if (!dirty) return false;
  load();
  fs.mkdirSync(path.dirname(ACCESS_FILE), { recursive: true });
  const tmp = `${ACCESS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, ACCESS_FILE);
  dirty = false;
  return true;
}

function record(id, type = 'recall') {
  if (!id) return;
  load();
  if (!cache[id]) cache[id] = { total: 0, last: null, by_type: {} };
  cache[id].total += 1;
  cache[id].last = new Date().toISOString();
  cache[id].by_type[type] = (cache[id].by_type[type] || 0) + 1;
  dirty = true;
}

function get(id) {
  load();
  return cache[id] || { total: 0, last: null, by_type: {} };
}

function start(intervalMs = 30000) {
  if (timerHandle) return timerHandle;
  timerHandle = setInterval(() => {
    try { flush(); } catch (e) { console.error('access flush error:', e.message); }
  }, intervalMs);
  if (typeof timerHandle.unref === 'function') timerHandle.unref();
  return timerHandle;
}

function stop() {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
  flush();
}

function* walkAllRooms() {
  if (!fs.existsSync(WINGS_DIR)) return;
  for (const wing of fs.readdirSync(WINGS_DIR)) {
    const wingDir = path.join(WINGS_DIR, wing);
    if (!fs.statSync(wingDir).isDirectory()) continue;
    for (const hall of fs.readdirSync(wingDir)) {
      const hallDir = path.join(wingDir, hall);
      let stat;
      try { stat = fs.statSync(hallDir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      for (const file of fs.readdirSync(hallDir)) {
        if (!file.endsWith('.md')) continue;
        yield { wing, hall, id: path.basename(file, '.md') };
      }
    }
  }
}

function init() {
  load();
  let added = 0;
  for (const room of walkAllRooms()) {
    if (!cache[room.id]) {
      cache[room.id] = { total: 0, last: null, by_type: {} };
      added++;
    }
  }
  if (added > 0) dirty = true;
  flush();
  return added;
}

function stats() {
  load();
  const ids = Object.keys(cache);
  const totalAccessed = ids.filter(id => cache[id].total > 0).length;
  const sorted = ids
    .map(id => ({ id, total: cache[id].total, last: cache[id].last }))
    .sort((a, b) => b.total - a.total);
  return {
    totalRecords: ids.length,
    totalAccessed,
    cold: sorted.filter(r => r.total === 0).length,
    hot: sorted.slice(0, 10),
  };
}

module.exports = { record, get, flush, start, stop, init, stats };

// ─── CLI ───────────────────────────────────────────────────────────────────
if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'init') {
    const added = init();
    console.log(`Seeded ${added} new record entries → ${ACCESS_FILE}`);
  } else if (cmd === 'record') {
    const [, , , id, type] = process.argv;
    if (!id) { console.error('Usage: palace-access.js record <id> [type]'); process.exit(1); }
    record(id, type);
    flush();
    console.log(JSON.stringify(get(id), null, 2));
  } else if (cmd === 'stats') {
    const s = stats();
    console.log(`Total records:    ${s.totalRecords}`);
    console.log(`With ≥1 access:   ${s.totalAccessed}`);
    console.log(`Cold (0 access):  ${s.cold}`);
    console.log(`\nHottest:`);
    for (const r of s.hot) {
      if (r.total === 0) break;
      console.log(`  ${r.id}  total=${r.total}  last=${r.last || '—'}`);
    }
  } else {
    console.log('Usage: palace-access.js {init|record <id> [type]|stats}');
    process.exit(2);
  }
}
