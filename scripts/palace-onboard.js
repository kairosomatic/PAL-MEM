#!/usr/bin/env node
'use strict';

/**
 * palace-onboard.js — generalized markdown import (spec §13).
 *
 * Walk a foreign markdown tree, classify each file, and write stamped records
 * into PAL at the chosen wing/hall. Two postures:
 *
 *   conservative (default):  trust=<unstamped>, review_required=true   → quarantine
 *   --include-trusted:       trust=medium, review_required=false       → published
 *
 * The conservative path is the default for ANY foreign corpus — content
 * from another operator's sessions has a writer-vs-content trust gap that
 * `palace promote` is designed to close one record at a time. The trusted
 * shorthand is for operators importing their own past work where the gap
 * is not a concern.
 *
 * Out of scope for v2.1:
 *   - --map-frontmatter (foreign-field renaming)
 *   - inline abstract + embedding generation (next reload picks them up)
 *   - allowlist expansion (operator runs `palace allowlist add` separately)
 *
 * Usage:
 *   node palace-onboard.js <source-dir> --target-wing <w> --target-hall <h> --dry-run
 *   node palace-onboard.js <source-dir> --target-wing <w> --target-hall <h> --apply
 *     [--default-trust high|medium|low|unreviewed]
 *     [--default-source <string>]
 *     [--include-trusted]
 *     [--review-required-by-default]
 */

const fs    = require('fs');
const path  = require('path');
const paths = require('./palace-paths.js');
const trust = require('./palace-trust.js');

const AUDIT_LOG = paths.EXPOSURE_AUDIT;

// ─── Walk + parse ───────────────────────────────────────────────────────────

function* walkMarkdown(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const full = path.join(dir, name);
      let st;
      try { st = fs.lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { stack.push(full); continue; }
      if (st.isFile() && name.endsWith('.md')) yield full;
    }
  }
}

function parseFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { meta: {}, body: text };
  const meta = {};
  let i = 1;
  while (i < lines.length && lines[i] !== '---') {
    const c = lines[i].indexOf(':');
    if (c !== -1) {
      const k = lines[i].slice(0, c).trim();
      const v = lines[i].slice(c + 1).trim();
      if (!(k in meta)) meta[k] = v;
    }
    i++;
  }
  if (i >= lines.length) return { meta: {}, body: text };
  return { meta, body: lines.slice(i + 1).join('\n') };
}

function bodyEmpty(body) {
  return !body || body.trim().length < 20;
}

// ─── Defaults + classify ────────────────────────────────────────────────────

function resolveDefaults(opts) {
  // --include-trusted overrides individual flags when set.
  if (opts.includeTrusted) {
    return {
      trust:           'medium',
      review_required: false,
      source:          opts.defaultSource,
      mode:            'trusted',
    };
  }
  return {
    trust:           opts.defaultTrust === 'unreviewed' ? null : opts.defaultTrust,
    review_required: opts.reviewRequiredByDefault,
    source:          opts.defaultSource,
    mode:            'conservative',
  };
}

function classifyFile(filePath, sourceRoot, opts, defaults) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); }
  catch (e) { return { skip: 'unreadable', reason: e.message }; }

  const { meta, body } = parseFrontmatter(text);
  if (bodyEmpty(body)) return { skip: 'empty_body' };

  const id      = meta.id || `r-onboard-${Date.now()}-${path.basename(filePath, '.md').slice(0, 24)}`;
  const created = meta.created || (new Date(fs.statSync(filePath).mtime).toISOString().slice(0, 10));

  // Apply defaults only where foreign frontmatter lacks them.
  const stamped = {
    id,
    wing:            opts.targetWing,
    hall:            opts.targetHall,
    created,
    tags:            meta.tags || `[onboard, ${opts.defaultSource.replace(/[^a-z0-9]/gi, '-')}]`,
    trust:           meta.trust  || defaults.trust,
    source:          meta.source || defaults.source,
    review_required: meta.review_required === 'true' ? true : defaults.review_required,
  };

  // Compute visibility against the merged record.
  const visibility = paths.defaultVisibility({
    trust:           stamped.trust,
    source:          stamped.source,
    review_required: stamped.review_required,
    archived:        false,
  });

  return {
    sourcePath: filePath,
    relPath:    path.relative(sourceRoot, filePath),
    id,
    stamped,
    visibility,
    body,
    foreignMeta: meta,
  };
}

// ─── Write path ─────────────────────────────────────────────────────────────

function serialize(stamped, body) {
  // Build minimal frontmatter — only fields we own. Preserve foreign body.
  const lines = ['---'];
  lines.push(`id: ${stamped.id}`);
  lines.push(`wing: ${stamped.wing}`);
  lines.push(`hall: ${stamped.hall}`);
  lines.push(`created: ${stamped.created}`);
  lines.push(`tags: ${stamped.tags}`);
  if (stamped.trust)  lines.push(`trust: ${stamped.trust}`);
  if (stamped.source) lines.push(`source: ${stamped.source}`);
  if (stamped.review_required) lines.push(`review_required: true`);
  lines.push(`onboarded_at: ${new Date().toISOString()}`);
  lines.push('---');
  lines.push(body);
  return lines.join('\n');
}

async function writeRecord(item) {
  const baseRoot = item.visibility === 'published'
    ? paths.ROOTS.published
    : paths.ROOTS.quarantine;
  const dir  = path.join(baseRoot, item.stamped.wing, item.stamped.hall);
  const file = path.join(dir, `${item.id}.md`);
  fs.mkdirSync(dir, { recursive: true });
  paths.writeAtomic(file, serialize(item.stamped, item.body));
  return file;
}

// ─── Main ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      const v = next && !next.startsWith('--') ? argv[++i] : true;
      out[k] = v;
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const sourceDir = flags._[0];
  if (!sourceDir) {
    process.stderr.write('Usage: palace-onboard.js <source-dir> --target-wing <w> --target-hall <h> [--dry-run|--apply]\n');
    process.exit(2);
  }
  if (!fs.existsSync(sourceDir)) {
    process.stderr.write(`source-dir not found: ${sourceDir}\n`);
    process.exit(2);
  }
  if (!flags['target-wing'] || !flags['target-hall']) {
    process.stderr.write('--target-wing and --target-hall required\n');
    process.exit(2);
  }
  if (!flags['dry-run'] && !flags.apply) {
    process.stderr.write('one of --dry-run or --apply required\n');
    process.exit(2);
  }

  const opts = {
    targetWing:              flags['target-wing'],
    targetHall:              flags['target-hall'],
    defaultTrust:            flags['default-trust'] || 'unreviewed',
    defaultSource:           flags['default-source'] || `import:${path.basename(sourceDir)}`,
    includeTrusted:          flags['include-trusted'] === true,
    reviewRequiredByDefault: flags['review-required-by-default'] !== false &&
                             !flags['include-trusted'],
  };
  const defaults = resolveDefaults(opts);

  console.log(`Source:        ${sourceDir}`);
  console.log(`Target:        ${opts.targetWing}/${opts.targetHall}`);
  console.log(`Posture:       ${defaults.mode}`);
  console.log(`Default trust: ${defaults.trust ?? '<unstamped>'}`);
  console.log(`Default src:   ${defaults.source}`);
  console.log(`Review req:    ${defaults.review_required}`);
  console.log('');

  // Walk + classify.
  const items = [];
  const skipped = { empty_body: 0, unreadable: 0 };
  let total = 0;
  for (const file of walkMarkdown(sourceDir)) {
    total++;
    const c = classifyFile(file, sourceDir, opts, defaults);
    if (c.skip) { skipped[c.skip] = (skipped[c.skip] || 0) + 1; continue; }
    items.push(c);
  }

  const willPublish  = items.filter(i => i.visibility === 'published').length;
  const willQuar     = items.filter(i => i.visibility === 'quarantine').length;
  console.log(`Files seen:    ${total}`);
  console.log(`  classified:  ${items.length}`);
  console.log(`  → published: ${willPublish}`);
  console.log(`  → quarantine:${willQuar}`);
  console.log(`  skipped:     ${JSON.stringify(skipped)}`);
  console.log('');

  // Sample preview.
  if (items.length) {
    console.log('── Sample (first 3) ──');
    for (const it of items.slice(0, 3)) {
      console.log(`  ${it.relPath} → ${it.visibility}`);
      console.log(`    trust=${it.stamped.trust ?? '<null>'} source=${it.stamped.source} review_required=${it.stamped.review_required}`);
    }
    console.log('');
  }

  if (flags['dry-run']) {
    console.log('Dry-run complete. No files written.');
    return;
  }

  // Apply.
  console.log(`Applying ${items.length} record writes…`);
  let written = 0;
  let failed  = 0;
  await paths.withWriteLock(async () => {
    for (const item of items) {
      try {
        await writeRecord(item);
        written++;
      } catch (e) {
        failed++;
        console.error(`  FAILED: ${item.relPath} — ${e.message}`);
      }
    }
  });

  // Audit summary.
  fs.mkdirSync(path.dirname(AUDIT_LOG), { recursive: true });
  fs.appendFileSync(AUDIT_LOG, JSON.stringify({
    ts:                new Date().toISOString(),
    action:            'onboard',
    source:            sourceDir,
    target:            `${opts.targetWing}/${opts.targetHall}`,
    posture:           defaults.mode,
    count_published:   willPublish,
    count_quarantine:  willQuar,
    count_failed:      failed,
    options: {
      default_trust:    defaults.trust,
      default_source:   defaults.source,
      review_required:  defaults.review_required,
    },
  }) + '\n');

  console.log('');
  console.log(`Onboard complete: ${written} written, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`onboard failed: ${e.message}\n`);
    process.exit(1);
  });
}

module.exports = { walkMarkdown, classifyFile, resolveDefaults };
