#!/usr/bin/env node
'use strict';

/**
 * palace-migrate.js — one-shot migration of legacy ~/.palace/wings/ records
 * into v2.1's default-visibility model.
 *
 *   node palace-migrate.js --dry-run     # walk corpus, list planned changes
 *   node palace-migrate.js --apply       # execute (step 5; gated on review)
 *
 * For each record under ~/.palace/wings/:
 *   - missing `trust`  → stamp `trust: medium, source: legacy-local`
 *   - missing `source` → stamp `source: legacy-local`
 *   - already has both → leave alone
 *   - trust=low or review_required=true → would route to quarantine
 *
 * No `review_required: true` is added to legacy records — this migration is
 * scoped to the operator's own local corpus, where the writer-vs-content
 * trust gap doesn't apply. Foreign corpora use `palace onboard` (§13) which
 * defaults to conservative routing.
 *
 * Spec: ideas/Hw/pal-trust-default-visibility-v2.1-spec.md §7
 */

const fs    = require('fs');
const path  = require('path');
const paths = require('./palace-paths.js');

const MIGRATION_TAG = 'pal-phase-5-2026-05-08';
const DEFAULT_TRUST  = 'medium';
const DEFAULT_SOURCE = 'legacy-local';

// Sources written by the pre-v2.1 default fallback in palace.js (`source: agent`
// for any high-trust write without an explicit source). These get rewritten to
// `legacy-local` during migrate — they are operator-authored content, just from
// before the trust model required explicit provenance. Step 3 closes the
// loophole in palace.js so new writes can't fall back to `agent`.
const SOURCE_REWRITES = {
  agent:   DEFAULT_SOURCE,
  unknown: DEFAULT_SOURCE,
};

// ─── Frontmatter helpers ───────────────────────────────────────────────────

function parseFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { meta: null, bodyStart: 0 };
  const meta = {};
  let i = 1;
  while (i < lines.length && lines[i] !== '---') {
    const colonIdx = lines[i].indexOf(': ');
    if (colonIdx !== -1) {
      const key = lines[i].slice(0, colonIdx).trim();
      const val = lines[i].slice(colonIdx + 2).trim();
      meta[key] = val;
    }
    i++;
  }
  if (i >= lines.length) return { meta: null, bodyStart: 0 };  // unclosed
  return { meta, bodyStart: i + 1 };
}

function coerce(meta) {
  // Map raw frontmatter strings into the record shape defaultVisibility expects.
  if (!meta) return {};
  return {
    id:               meta.id,
    wing:             meta.wing,
    hall:             meta.hall,
    trust:            meta.trust || null,
    source:           meta.source || null,
    review_required:  meta.review_required === 'true',
    archived:         meta.archived === 'true',
  };
}

// ─── Walk + classify ───────────────────────────────────────────────────────

function* walkMarkdown(root) {
  if (!fs.existsSync(root)) return;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { stack.push(full); continue; }
      if (st.isFile() && name.endsWith('.md')) yield full;
    }
  }
}

function classify(record, meta) {
  // What this record needs and where it would land.
  const needsTrust       = !meta.trust;
  const needsSource      = !meta.source;
  const sourceRewriteTo  = !needsSource && SOURCE_REWRITES[meta.source] ? SOURCE_REWRITES[meta.source] : null;

  // Apply the planned stamps to a synthetic record, then run defaultVisibility.
  const stamped = Object.assign({}, record);
  if (needsTrust)       stamped.trust  = DEFAULT_TRUST;
  if (needsSource)      stamped.source = DEFAULT_SOURCE;
  if (sourceRewriteTo)  stamped.source = sourceRewriteTo;

  const visBefore = paths.defaultVisibility(record);
  const visAfter  = paths.defaultVisibility(stamped);

  let status;
  if (!needsTrust && !needsSource && !sourceRewriteTo)            status = 'already_stamped';
  else if (needsTrust && needsSource)                             status = 'stamp_trust_and_source';
  else if (needsTrust)                                            status = 'stamp_trust';
  else if (needsSource)                                           status = 'stamp_source';
  else if (sourceRewriteTo)                                       status = 'rewrite_source';

  return {
    needsTrust,
    needsSource,
    sourceRewriteTo,
    visBefore,
    visAfter,
    movesToQuarantine: visAfter === 'quarantine',
    status,
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  const flags = new Set(process.argv.slice(2));
  const dryRun = flags.has('--dry-run');
  const apply  = flags.has('--apply');
  if (!dryRun && !apply) {
    console.error('Usage: palace-migrate.js --dry-run | --apply');
    process.exit(2);
  }
  const root = paths.ROOTS.published;
  console.log(`Scanning: ${root}`);
  console.log(`Migration tag: ${MIGRATION_TAG}`);
  console.log('');

  const buckets = {
    already_stamped:         [],
    stamp_trust:             [],
    stamp_source:            [],
    stamp_trust_and_source:  [],
    rewrite_source:          [],
    quarantine_after_stamp:  [],   // would route to quarantine post-stamp
    unparseable:             [],
  };

  let total = 0;
  for (const file of walkMarkdown(root)) {
    total++;
    const text = fs.readFileSync(file, 'utf8');
    const { meta } = parseFrontmatter(text);
    if (!meta) {
      buckets.unparseable.push(file);
      continue;
    }
    const record = coerce(meta);
    const c = classify(record, meta);
    buckets[c.status].push({ file, record, meta, c });
    if (c.movesToQuarantine) buckets.quarantine_after_stamp.push({ file, record, c });
  }

  // ─── Summary ───
  console.log(`Total records under wings/:        ${total}`);
  console.log(`  already stamped (trust+source):  ${buckets.already_stamped.length}`);
  console.log(`  need stamp: trust + source:      ${buckets.stamp_trust_and_source.length}`);
  console.log(`  need stamp: trust only:          ${buckets.stamp_trust.length}`);
  console.log(`  need stamp: source only:         ${buckets.stamp_source.length}`);
  console.log(`  rewrite source (agent→legacy):   ${buckets.rewrite_source.length}`);
  console.log(`  unparseable frontmatter:         ${buckets.unparseable.length}`);
  console.log(`  would route to quarantine:       ${buckets.quarantine_after_stamp.length}`);
  console.log('');

  // ─── Sample previews ───
  function preview(label, rows, n = 3) {
    if (!rows.length) return;
    console.log(`── ${label} (sample of ${Math.min(n, rows.length)}) ──`);
    for (const r of rows.slice(0, n)) {
      const rel = path.relative(paths.PALACE_HOME, r.file || r);
      const detail = r.record
        ? `trust=${r.record.trust ?? '<missing>'} source=${r.record.source ?? '<missing>'}`
        : '';
      console.log(`  ${rel}${detail ? '  ' + detail : ''}`);
    }
    console.log('');
  }

  preview('Stamp trust + source',  buckets.stamp_trust_and_source);
  preview('Stamp source only',     buckets.stamp_source);
  preview('Stamp trust only',      buckets.stamp_trust);
  preview('Rewrite source (agent→legacy-local)', buckets.rewrite_source);
  preview('Would move to quarantine', buckets.quarantine_after_stamp.map(r => ({ file: r.file, record: r.record })));
  preview('Unparseable',           buckets.unparseable.map(f => ({ file: f })));

  // ─── Quarantine breakdown (why?) ───
  if (buckets.quarantine_after_stamp.length) {
    console.log('── Quarantine reasons ──');
    const reasons = {};
    for (const { record } of buckets.quarantine_after_stamp) {
      let why;
      if (record.trust === 'low')              why = 'trust=low';
      else if (record.review_required === true) why = 'review_required=true';
      else if (!paths.isTrustedSource(record.source || DEFAULT_SOURCE)) why = `untrusted source: ${record.source}`;
      else why = 'other';
      reasons[why] = (reasons[why] || 0) + 1;
    }
    for (const [why, n] of Object.entries(reasons)) {
      console.log(`  ${why}: ${n}`);
    }
    console.log('');
  }

  if (dryRun) {
    console.log('Dry-run complete. No files modified.');
    console.log('To execute: re-run with --apply once this output has been reviewed.');
    return;
  }

  // ─── Apply path ─────────────────────────────────────────────────────────────
  // For every record that needs work, rewrite frontmatter atomically. Strategy:
  //   1. Acquire single write lock for the whole run (cheap; we own the corpus).
  //   2. For each record, parse → mutate header lines → writeAtomic.
  //   3. Stamp `migration_tag: pal-phase-5-2026-05-08` so we can audit later.
  // No backups; the records are git-tracked under ~/.palace and recoverable.
  const work = [
    ...buckets.stamp_trust_and_source,
    ...buckets.stamp_trust,
    ...buckets.stamp_source,
    ...buckets.rewrite_source,
  ];

  console.log(`Applying ${work.length} record updates…`);

  let applied = 0;
  let failed  = 0;
  paths.withWriteLock(async () => {
    for (const item of work) {
      try {
        const text  = fs.readFileSync(item.file, 'utf8');
        const next  = rewriteFrontmatter(text, item.c);
        if (next === text) continue;  // no-op safety
        paths.writeAtomic(item.file, next);
        applied++;
      } catch (e) {
        failed++;
        console.error(`  FAILED: ${item.file} — ${e.message}`);
      }
    }
  }).then(() => {
    console.log('');
    console.log(`Apply complete: ${applied} updated, ${failed} failed, ${buckets.unparseable.length} unparseable skipped.`);
    if (failed > 0) process.exit(1);
  }).catch((e) => {
    console.error(`Apply aborted: ${e.message}`);
    process.exit(1);
  });
}

// ─── Frontmatter rewriter ───────────────────────────────────────────────────

function rewriteFrontmatter(text, c) {
  // Walk header line-by-line, touching only the lines we own.
  // Insert missing lines just before the closing '---'.
  const lines = text.split('\n');
  if (lines[0] !== '---') return text;

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { endIdx = i; break; }
  }
  if (endIdx === -1) return text;  // unclosed; leave untouched

  let trustIdx       = -1;
  let sourceIdx      = -1;
  let migrationIdx   = -1;
  for (let i = 1; i < endIdx; i++) {
    const line = lines[i];
    if (line.startsWith('trust:')          && trustIdx     === -1) trustIdx     = i;
    if (line.startsWith('source:')         && sourceIdx    === -1) sourceIdx    = i;
    if (line.startsWith('migration_tag:')  && migrationIdx === -1) migrationIdx = i;
  }

  // Apply the planned mutations.
  if (c.needsTrust) {
    if (trustIdx !== -1) lines[trustIdx] = `trust: ${DEFAULT_TRUST}`;
    else                  lines.splice(endIdx, 0, `trust: ${DEFAULT_TRUST}`);
    // splice shifted endIdx
    if (trustIdx === -1) endIdx++;
  }
  if (c.needsSource) {
    if (sourceIdx !== -1) lines[sourceIdx] = `source: ${DEFAULT_SOURCE}`;
    else                   lines.splice(endIdx, 0, `source: ${DEFAULT_SOURCE}`);
    if (sourceIdx === -1) endIdx++;
  } else if (c.sourceRewriteTo) {
    if (sourceIdx !== -1) lines[sourceIdx] = `source: ${c.sourceRewriteTo}`;
  }

  // Stamp migration tag (replace existing if present).
  const tagLine = `migration_tag: ${MIGRATION_TAG}`;
  if (migrationIdx !== -1) lines[migrationIdx] = tagLine;
  else                      lines.splice(endIdx, 0, tagLine);

  return lines.join('\n');
}

main();
