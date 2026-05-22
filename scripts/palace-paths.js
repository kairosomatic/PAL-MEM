'use strict';

/**
 * palace-paths.js — central path + visibility policy.
 *
 * Sole owner of root path literals and the defaultVisibility() decision.
 * Every other module imports from here; no `wings/` or `quarantine/` strings
 * scattered across stores, retrievers, doctor, sweep, archive, CLI, REST, MCP.
 *
 * Spec: ideas/Hw/pal-trust-default-visibility-v2.1-spec.md §2
 */

const os     = require('os');
const fs     = require('fs');
const path   = require('path');
const config = require('./palace-config.js');

const PALACE_HOME = process.env.PALACE_HOME || path.join(os.homedir(), '.palace');

const ROOTS = {
  published:         path.join(PALACE_HOME, 'wings'),
  quarantine:        path.join(PALACE_HOME, 'quarantine', 'wings'),
  archivePublished:  path.join(PALACE_HOME, 'archive', 'wings'),
  archiveQuarantine: path.join(PALACE_HOME, 'archive', 'quarantine', 'wings'),
};

const INDEX_DIR        = path.join(PALACE_HOME, 'index');
const EXPOSURE_AUDIT   = path.join(INDEX_DIR, 'exposure-audit.jsonl');
const CONTENT_ACCESS   = path.join(INDEX_DIR, 'content-access.jsonl');
const WRITE_LOCK       = path.join(PALACE_HOME, '.lock');

// Framework-essential trusted-source prefixes. Operators add more via
// ~/.palace/config.json `trustedSourcePrefixes` (see palace-config.js).
const TRUSTED_SOURCE_PREFIXES = [
  'local-human',
  'claude-code:',
  'cowork:',
  'legacy-local',          // stamped by `palace migrate` on local corpora
];

function isTrustedSource(source) {
  if (!source) return false;
  const s = String(source);
  const all = TRUSTED_SOURCE_PREFIXES.concat(config.trustedSourcePrefixes());
  return all.some(p =>
    p.endsWith(':') || p.endsWith('-') ? s.startsWith(p) : s === p
  );
}

/**
 * defaultVisibility(record) → 'published' | 'quarantine' | 'archive'
 *
 * Order matters. Archive wins, then explicit review_required, then
 * trust-low, then unknown trust, then unknown/untrusted source.
 */
function defaultVisibility(record) {
  if (!record || typeof record !== 'object') return 'quarantine';
  if (record.archived === true)            return 'archive';
  if (record.review_required === true)     return 'quarantine';
  if (record.trust === 'low')              return 'quarantine';
  if (record.trust == null)                return 'quarantine';
  if (!isTrustedSource(record.source))     return 'quarantine';
  return 'published';
}

/**
 * defaultVisibilityIgnoringArchive — used to decide which archive root
 * an archived record belongs in. Same logic without the archive short-circuit.
 */
function defaultVisibilityIgnoringArchive(record) {
  const synthetic = Object.assign({}, record, { archived: false });
  return defaultVisibility(synthetic);
}

function rootForRecord(record) {
  const v = defaultVisibility(record);
  if (v === 'published')  return ROOTS.published;
  if (v === 'quarantine') return ROOTS.quarantine;
  throw new Error(`rootForRecord: archived records use archiveRootForRecord()`);
}

function archiveRootForRecord(record) {
  const liveVis = defaultVisibilityIgnoringArchive(record);
  return liveVis === 'published' ? ROOTS.archivePublished : ROOTS.archiveQuarantine;
}

/**
 * withWriteLock(fn) — exclusive lock on ~/.palace/.lock for the duration of fn.
 *
 * Uses fs.openSync(path, 'wx') for atomic create-or-fail; same single-host
 * mutex semantics as flock(2) for our use case (single operator, multiple
 * agents on one machine). Stale-lock detection: if the lockfile is older
 * than STALE_AFTER_MS, treat as crashed-holder and reclaim.
 *
 * Spec: §3 / §6 — all write paths (store, promote, demote, quarantine,
 * archive, restore, ephemeral-sweep, migrate --apply) wrap in this.
 */
const STALE_AFTER_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS    = 25;

async function withWriteLock(fn) {
  fs.mkdirSync(path.dirname(WRITE_LOCK), { recursive: true });

  const start = Date.now();
  let acquired = false;
  while (!acquired) {
    try {
      const fd = fs.openSync(WRITE_LOCK, 'wx');
      fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
      fs.closeSync(fd);
      acquired = true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Lock held — check for staleness.
      try {
        const st = fs.statSync(WRITE_LOCK);
        if (Date.now() - st.mtimeMs > STALE_AFTER_MS) {
          fs.unlinkSync(WRITE_LOCK);
          continue;
        }
      } catch { /* lock vanished mid-check */ }
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(`palace-paths.withWriteLock: timeout acquiring ${WRITE_LOCK} after ${LOCK_TIMEOUT_MS}ms`);
      }
      await new Promise(r => setTimeout(r, LOCK_POLL_MS));
    }
  }

  try {
    return await fn();
  } finally {
    try { fs.unlinkSync(WRITE_LOCK); } catch { /* ok */ }
  }
}

/**
 * writeAtomic(filePath, content) — temp + fsync + rename.
 * Caller is responsible for holding withWriteLock if cross-process safety needed.
 */
function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tempPath, content);
  const fd = fs.openSync(tempPath, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tempPath, filePath);
}

/**
 * Validates a single path segment (wing, hall, or id) before it joins a root.
 *
 * Why: `pathForRecord` and every other write helper builds an absolute path
 * by `path.join(root, wing, hall, id+'.md')`. If `wing` contains `..` or a
 * slash, `path.join` will happily escape the root — the MCP write tools
 * (`palace_remember`, `palace_forget`) accept wing/hall from untrusted
 * callers, and frontmatter `wing:`/`hall:` on quarantined records is also
 * caller-controlled. Reject anything that could escape the segment.
 *
 * Rules:
 *   - non-empty string, ≤64 chars
 *   - no `/`, `\`, or null byte (segment separators)
 *   - no `..` anywhere (parent-dir escape)
 *   - cannot start with `.` (hidden dirs and `./`/`../` prefixes)
 *   - allowed chars: letters, digits, `_`, `-`, `.`
 */
const SEGMENT_RE = /^[A-Za-z0-9_\-.]+$/;
const SEGMENT_MAX = 64;

function assertSafeSegment(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`palace-paths: ${label} must be a non-empty string`);
  }
  if (value.length > SEGMENT_MAX) {
    throw new Error(`palace-paths: ${label} exceeds ${SEGMENT_MAX} chars`);
  }
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error(`palace-paths: ${label} contains a path separator`);
  }
  if (value === '..' || value === '.' || value.includes('..')) {
    throw new Error(`palace-paths: ${label} contains parent-dir escape`);
  }
  if (value.startsWith('.')) {
    throw new Error(`palace-paths: ${label} cannot start with '.'`);
  }
  if (!SEGMENT_RE.test(value)) {
    throw new Error(`palace-paths: ${label} contains disallowed characters`);
  }
}

/**
 * pathForRecord(record) → absolute file path under the correct root.
 * Caller still mkdirs the parent and writes via the atomic temp+rename pattern.
 */
function pathForRecord(record) {
  if (!record.id || !record.wing || !record.hall) {
    throw new Error('pathForRecord: record needs id, wing, hall');
  }
  assertSafeSegment(record.wing, 'wing');
  assertSafeSegment(record.hall, 'hall');
  assertSafeSegment(record.id,   'id');
  const root = record.archived ? archiveRootForRecord(record) : rootForRecord(record);
  return path.join(root, record.wing, record.hall, `${record.id}.md`);
}

module.exports = {
  PALACE_HOME,
  ROOTS,
  INDEX_DIR,
  EXPOSURE_AUDIT,
  CONTENT_ACCESS,
  WRITE_LOCK,
  TRUSTED_SOURCE_PREFIXES,
  isTrustedSource,
  defaultVisibility,
  defaultVisibilityIgnoringArchive,
  rootForRecord,
  archiveRootForRecord,
  pathForRecord,
  assertSafeSegment,
  withWriteLock,
  writeAtomic,
};
