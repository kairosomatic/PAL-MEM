#!/usr/bin/env node
'use strict';

/**
 * palace-promote.js — promote / demote / quarantine / restore.
 *
 * All operations:
 *   1. Acquire global write lock (~/.palace/.lock).
 *   2. Locate record by id under wings/ or quarantine/wings/ (or archive/ for restore).
 *   3. Mutate frontmatter in memory.
 *   4. Write new file at temp + fsync + rename under root from defaultVisibility(next).
 *   5. Move .emb sidecar by id (no hash recompute unless body changed — none of these
 *      operations touch the body).
 *   6. Delete old file if root changed.
 *   7. Append audit record to ~/.palace/index/exposure-audit.jsonl.
 *
 * Friction (spec §6):
 *   - --reason must be ≥ 12 chars and not match trivial patterns.
 *   - Promote: rate-limited to 10/hr; override requires explicit --override-rate-limit.
 *
 * Restore: walks archive trees, re-runs defaultVisibility() against current policy.
 *
 * Usage:
 *   node palace-promote.js promote    <id> --trust <high|medium> --reviewed-by <name> --reason "<text>"
 *   node palace-promote.js demote     <id> --trust low                                --reason "<text>"
 *   node palace-promote.js quarantine <id>                                            --reason "<text>"
 *   node palace-promote.js restore    <id>
 */

const fs    = require('fs');
const path  = require('path');
const paths = require('./palace-paths.js');

const AUDIT_LOG = paths.EXPOSURE_AUDIT;
const RATE_WINDOW_MS  = 60 * 60 * 1000;   // 1 hour
const RATE_LIMIT      = 10;
const REASON_MIN_LEN  = 12;
const REASON_TRIVIAL  = /^(ok|fine|yes|sure|done|.{0,3})$/i;

// ─── Frontmatter parser/serializer (minimal, single-line keys only) ─────────

function parseFile(fullPath) {
  const text = fs.readFileSync(fullPath, 'utf8');
  const lines = text.split('\n');
  if (lines[0] !== '---') return { meta: null, headerLines: [], body: text, text };
  const meta = {};
  const headerLines = [];
  let i = 1;
  while (i < lines.length && lines[i] !== '---') {
    headerLines.push(lines[i]);
    const c = lines[i].indexOf(':');
    if (c !== -1) {
      const k = lines[i].slice(0, c).trim();
      const v = lines[i].slice(c + 1).trim();
      if (!(k in meta)) meta[k] = v;
    }
    i++;
  }
  if (i >= lines.length) return { meta: null, headerLines, body: text, text };
  const closingIdx = i;
  const body = lines.slice(closingIdx + 1).join('\n');
  return { meta, headerLines, body, text };
}

function rewriteHeader(headerLines, mutations) {
  // mutations: { trust?, source?, review_required?, archived?, [audit fields...] }
  // Replace existing keys; append missing ones at end.
  const result = headerLines.slice();
  for (const [k, v] of Object.entries(mutations)) {
    let idx = -1;
    for (let i = 0; i < result.length; i++) {
      if (result[i].startsWith(`${k}:`)) { idx = i; break; }
    }
    const line = `${k}: ${v}`;
    if (idx !== -1) result[idx] = line;
    else result.push(line);
  }
  return result;
}

function serialize(headerLines, body) {
  return ['---', ...headerLines, '---', body].join('\n');
}

// ─── Record location ────────────────────────────────────────────────────────

function findRecordById(id) {
  // Search wings/ then quarantine/wings/. Returns { fullPath, root } or null.
  const candidates = [
    { root: 'published',  base: paths.ROOTS.published },
    { root: 'quarantine', base: paths.ROOTS.quarantine },
  ];
  for (const { root, base } of candidates) {
    if (!fs.existsSync(base)) continue;
    for (const wing of fs.readdirSync(base)) {
      const wingDir = path.join(base, wing);
      let s; try { s = fs.statSync(wingDir); } catch { continue; }
      if (!s.isDirectory()) continue;
      for (const hall of fs.readdirSync(wingDir)) {
        const hallDir = path.join(wingDir, hall);
        let hs; try { hs = fs.statSync(hallDir); } catch { continue; }
        if (!hs.isDirectory()) continue;
        const file = path.join(hallDir, `${id}.md`);
        if (fs.existsSync(file)) return { fullPath: file, root, wing, hall };
      }
    }
  }
  return null;
}

function findArchivedById(id) {
  const archives = [
    { kind: 'archivePublished',  base: paths.ROOTS.archivePublished },
    { kind: 'archiveQuarantine', base: paths.ROOTS.archiveQuarantine },
  ];
  for (const { kind, base } of archives) {
    if (!fs.existsSync(base)) continue;
    for (const wing of fs.readdirSync(base)) {
      const wingDir = path.join(base, wing);
      let s; try { s = fs.statSync(wingDir); } catch { continue; }
      if (!s.isDirectory()) continue;
      for (const hall of fs.readdirSync(wingDir)) {
        const hallDir = path.join(wingDir, hall);
        let hs; try { hs = fs.statSync(hallDir); } catch { continue; }
        if (!hs.isDirectory()) continue;
        const file = path.join(hallDir, `${id}.md`);
        if (fs.existsSync(file)) return { fullPath: file, kind, wing, hall };
      }
    }
  }
  return null;
}

// ─── Audit ──────────────────────────────────────────────────────────────────

function appendAudit(entry) {
  fs.mkdirSync(path.dirname(AUDIT_LOG), { recursive: true });
  fs.appendFileSync(AUDIT_LOG, JSON.stringify(entry) + '\n');
}

function readAudit() {
  if (!fs.existsSync(AUDIT_LOG)) return [];
  return fs.readFileSync(AUDIT_LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function recentPromotionCount() {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  return readAudit().filter(e =>
    e.action === 'promote' && new Date(e.ts).getTime() >= cutoff,
  ).length;
}

// ─── Friction ──────────────────────────────────────────────────────────────

function validateReason(reason) {
  if (!reason || reason.length < REASON_MIN_LEN) {
    throw new Error(`--reason required, ≥${REASON_MIN_LEN} chars (got ${reason?.length || 0})`);
  }
  if (REASON_TRIVIAL.test(reason.trim())) {
    throw new Error(`--reason looks trivial; describe the decision (got "${reason}")`);
  }
}

// ─── Move primitives ────────────────────────────────────────────────────────

function relocateAndStamp({ from, fromRoot, mutations, action, reason, reviewedBy, override }) {
  // Read, mutate, compute new root, atomic-write to new location, move emb,
  // delete old, append audit. All inside withWriteLock.
  return paths.withWriteLock(async () => {
    const parsed = parseFile(from);
    if (!parsed.meta) throw new Error(`unparseable frontmatter: ${from}`);

    const id   = parsed.meta.id || path.basename(from, '.md');
    const wing = parsed.meta.wing;
    const hall = parsed.meta.hall;
    if (!wing || !hall) throw new Error(`record ${id} missing wing/hall`);

    // Compose updated record for visibility decision.
    const next = {
      id, wing, hall,
      trust:           mutations.trust          !== undefined ? mutations.trust          : parsed.meta.trust,
      source:          mutations.source         !== undefined ? mutations.source         : parsed.meta.source,
      review_required: mutations.review_required !== undefined ? mutations.review_required : (parsed.meta.review_required === 'true'),
      archived:        mutations.archived       !== undefined ? mutations.archived       : (parsed.meta.archived === 'true'),
    };
    const newRoot = paths.defaultVisibility(next);
    if (newRoot === 'archive') throw new Error(`record ${id} would route to archive — not supported by ${action}`);

    const baseRoot = newRoot === 'published' ? paths.ROOTS.published : paths.ROOTS.quarantine;
    const newDir   = path.join(baseRoot, wing, hall);
    const newPath  = path.join(newDir, `${id}.md`);

    // Mutations to write into the file (string-form).
    const headerMutations = {};
    if (mutations.trust          !== undefined) headerMutations.trust          = mutations.trust;
    if (mutations.source         !== undefined) headerMutations.source         = mutations.source;
    if (mutations.review_required !== undefined) headerMutations.review_required = String(mutations.review_required);
    if (mutations.archived       !== undefined) headerMutations.archived       = String(mutations.archived);
    headerMutations.last_action     = action;
    headerMutations.last_action_at  = new Date().toISOString();
    if (reason)     headerMutations.last_action_reason      = JSON.stringify(reason);
    if (reviewedBy) headerMutations.last_action_reviewed_by = reviewedBy;

    const newHeaderLines = rewriteHeader(parsed.headerLines, headerMutations);
    const out = serialize(newHeaderLines, parsed.body);

    fs.mkdirSync(newDir, { recursive: true });
    paths.writeAtomic(newPath, out);

    // Move .emb sidecar if present, by id (no hash recompute — body unchanged).
    const oldEmb = from.replace(/\.md$/, '.emb');
    const newEmb = newPath.replace(/\.md$/, '.emb');
    if (fs.existsSync(oldEmb) && oldEmb !== newEmb) {
      fs.renameSync(oldEmb, newEmb);
    }

    // Delete old .md if location changed.
    if (path.resolve(newPath) !== path.resolve(from)) {
      fs.unlinkSync(from);
    }

    // Audit.
    appendAudit({
      ts:           new Date().toISOString(),
      id,
      action,
      prior:        { root: fromRoot, trust: parsed.meta.trust || null, source: parsed.meta.source || null },
      next:         { root: newRoot,  trust: next.trust || null,        source: next.source || null },
      reason:       reason || null,
      reviewed_by:  reviewedBy || null,
      override:     override || null,
      from_path:    path.relative(paths.PALACE_HOME, from),
      to_path:      path.relative(paths.PALACE_HOME, newPath),
    });

    return { id, prior: fromRoot, next: newRoot, path: newPath };
  });
}

// ─── Public ops ─────────────────────────────────────────────────────────────

async function promote({ id, trust, reviewedBy, reason, override }) {
  if (!['high', 'medium'].includes(trust)) {
    throw new Error(`promote --trust must be 'high' or 'medium' (got '${trust}')`);
  }
  if (!reviewedBy) throw new Error(`--reviewed-by required for promote`);
  validateReason(reason);

  // Rate limit (post-validation so we don't burn a check on a malformed call).
  const recent = recentPromotionCount();
  if (recent >= RATE_LIMIT && !override) {
    throw new Error(
      `Rate-limit triggered: ${recent}/${RATE_LIMIT} promotions in last hour. ` +
      `Continue with --override-rate-limit "<reason>".`,
    );
  }
  if (override) validateReason(override);

  const found = findRecordById(id);
  if (!found) throw new Error(`record not found: ${id}`);

  return relocateAndStamp({
    from: found.fullPath, fromRoot: found.root,
    mutations: { trust, review_required: false },
    action: 'promote', reason, reviewedBy, override,
  });
}

async function demote({ id, reason }) {
  validateReason(reason);
  const found = findRecordById(id);
  if (!found) throw new Error(`record not found: ${id}`);
  return relocateAndStamp({
    from: found.fullPath, fromRoot: found.root,
    mutations: { trust: 'low' },
    action: 'demote', reason,
  });
}

async function quarantine({ id, reason }) {
  validateReason(reason);
  const found = findRecordById(id);
  if (!found) throw new Error(`record not found: ${id}`);
  return relocateAndStamp({
    from: found.fullPath, fromRoot: found.root,
    mutations: { review_required: true },
    action: 'quarantine', reason,
  });
}

async function restore({ id }) {
  // Restore: pull from archive, re-run defaultVisibility() against current policy.
  // No reason required (restore is a re-evaluation, not a judgment).
  const archived = findArchivedById(id);
  if (!archived) throw new Error(`record not found in archive: ${id}`);
  return relocateAndStamp({
    from: archived.fullPath, fromRoot: archived.kind,
    mutations: { archived: false },
    action: 'restore',
  });
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[k] = v;
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function main() {
  const [,, cmd, ...rest] = process.argv;
  const flags = parseArgs(rest);
  const id = flags._[0];

  try {
    let result;
    if (cmd === 'promote') {
      result = await promote({
        id, trust: flags.trust, reviewedBy: flags['reviewed-by'],
        reason: flags.reason, override: flags['override-rate-limit'] || null,
      });
    } else if (cmd === 'demote') {
      result = await demote({ id, reason: flags.reason });
    } else if (cmd === 'quarantine') {
      result = await quarantine({ id, reason: flags.reason });
    } else if (cmd === 'restore') {
      result = await restore({ id });
    } else {
      process.stderr.write('Usage: palace-promote.js <promote|demote|quarantine|restore> <id> [flags]\n');
      process.exit(2);
    }
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (e) {
    process.stderr.write(e.message + '\n');
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { promote, demote, quarantine, restore, validateReason, recentPromotionCount };
