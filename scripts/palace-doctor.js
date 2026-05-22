#!/usr/bin/env node
'use strict';

/**
 * palace-doctor.js — Health check for the Palace corpus.
 *
 * v2.1 visibility invariants (fail = non-zero exit):
 *   1. wings/ contains a record with trust: low
 *   2. wings/ contains a record with review_required: true
 *   3. wings/ contains a record with missing trust (post-migration)
 *   4. Any symlink under any Palace root (lstat)
 *   5. Same record ID present in both wings/ and quarantine/wings/
 *   6. Markdown file without parseable frontmatter under any root
 *   7. wings/ record carries injection_patterns without last_action: promote
 *      (only path to published for an injection-flagged record is explicit
 *      operator promote — catches stale-writer-process leaks)
 *
 * Health checks (informational, do not fail exit):
 *   • Records missing an abstract
 *   • Orphan .emb files (no matching .md)
 *   • .md files whose .emb is missing
 *   • Hash drift: abstract_hash in record disagrees with embeddings-manifest
 *   • Cold records: never accessed and > 90 days old
 *   • Duplicate IDs across wings
 *
 * Run:
 *   node palace-doctor.js [--json]
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths  = require('./palace-paths.js');

const PALACE_HOME = paths.PALACE_HOME;
const WINGS_DIR   = paths.ROOTS.published;
const QUAR_DIR    = paths.ROOTS.quarantine;
const MANIFEST    = path.join(PALACE_HOME, 'index', 'embeddings-manifest.json');
const ACCESS_FILE = path.join(PALACE_HOME, 'index', 'access.json');

const JSON_OUT = process.argv.includes('--json');
const NOW = Date.now();
const COLD_DAYS = 90;

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

const TINY_BODY_THRESHOLD = 20;

function* walkRooms() {
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
        if (file.endsWith('.md')) {
          yield { kind: 'md', wing, hall, file, fullPath: path.join(hallDir, file) };
        } else if (file.endsWith('.emb')) {
          yield { kind: 'emb', wing, hall, file, fullPath: path.join(hallDir, file) };
        }
      }
    }
  }
}

function loadJSON(file) {
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return {}; }
}

// ─── v2.1 visibility invariants ────────────────────────────────────────────

function* walkAllRoots() {
  for (const [name, root] of Object.entries(paths.ROOTS)) {
    if (!fs.existsSync(root)) continue;
    yield* walkRoot(root, name);
  }
}

function* walkRoot(root, rootName) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const full = path.join(dir, name);
      let st;
      try { st = fs.lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) {
        yield { kind: 'symlink', root: rootName, fullPath: full };
        continue;
      }
      if (st.isDirectory()) { stack.push(full); continue; }
      if (st.isFile() && name.endsWith('.md')) {
        yield { kind: 'md', root: rootName, fullPath: full };
      }
    }
  }
}

function checkInvariants() {
  const violations = {
    trustLowInWings:        [],
    reviewRequiredInWings:  [],
    missingTrustInWings:    [],
    symlinks:               [],
    idsInBothTrees:         [],
    unparseableFrontmatter: [],
    injectionInWingsWithoutPromote: [],
  };

  const idsByRoot = { published: new Set(), quarantine: new Set() };

  for (const item of walkAllRoots()) {
    if (item.kind === 'symlink') {
      violations.symlinks.push(path.relative(PALACE_HOME, item.fullPath));
      continue;
    }
    if (item.kind !== 'md') continue;

    let text;
    try { text = fs.readFileSync(item.fullPath, 'utf8'); } catch { continue; }
    const { meta } = parseFrontmatter(text);
    const rel = path.relative(PALACE_HOME, item.fullPath);

    if (!meta || Object.keys(meta).length === 0) {
      violations.unparseableFrontmatter.push(rel);
      continue;
    }

    const id = meta.id || path.basename(item.fullPath, '.md');
    if (item.root === 'published')  idsByRoot.published.add(id);
    if (item.root === 'quarantine') idsByRoot.quarantine.add(id);

    if (item.root === 'published') {
      if (meta.trust === 'low')                   violations.trustLowInWings.push(rel);
      if (meta.review_required === 'true')        violations.reviewRequiredInWings.push(rel);
      if (meta.trust == null || meta.trust === '') violations.missingTrustInWings.push(rel);
      const inj = meta.injection_patterns;
      const hasInjection = inj != null && inj !== '' && inj !== '[]';
      if (hasInjection && meta.last_action !== 'promote') {
        violations.injectionInWingsWithoutPromote.push(rel);
      }
    }
  }

  for (const id of idsByRoot.published) {
    if (idsByRoot.quarantine.has(id)) violations.idsInBothTrees.push(id);
  }

  return violations;
}

function main() {
  const findings = {
    missingAbstract: [],
    missingEmb:      [],
    orphanEmb:       [],
    hashDrift:       [],
    coldRecords:     [],
    duplicateIds:    [],
  };
  let tinyBodySkipped = 0;

  const mdById = new Map();        // id → [{wing, hall, fullPath}]
  const mdByPath = new Map();      // .md fullPath → meta
  const embByPath = new Set();     // .emb fullPath
  const manifest = loadJSON(MANIFEST);
  const access   = loadJSON(ACCESS_FILE);

  let total = 0;
  for (const room of walkRooms()) {
    if (room.kind === 'md') {
      total++;
      let text;
      try { text = fs.readFileSync(room.fullPath, 'utf8'); }
      catch { continue; }
      const { meta, body } = parseFrontmatter(text);
      const id = meta.id || path.basename(room.file, '.md');
      mdByPath.set(room.fullPath, { meta, wing: room.wing, hall: room.hall, id });

      if (!mdById.has(id)) mdById.set(id, []);
      mdById.get(id).push({ wing: room.wing, hall: room.hall, fullPath: room.fullPath });

      const tooSmallToAbstract = !body || body.trim().length < TINY_BODY_THRESHOLD;
      if (!meta.abstract && !tooSmallToAbstract) {
        findings.missingAbstract.push(`${room.wing}/${room.hall}/${room.file}`);
      } else if (!meta.abstract && tooSmallToAbstract) {
        tinyBodySkipped++;
      }

      const expectedEmb = room.fullPath.replace(/\.md$/, '.emb');
      if (meta.abstract && !fs.existsSync(expectedEmb)) {
        findings.missingEmb.push(`${room.wing}/${room.hall}/${room.file}`);
      }

      // Hash drift check
      if (meta.abstract && meta.abstract_hash) {
        const key = `${room.wing}/${room.hall}/${id}`;
        const m = manifest[key];
        if (m && m.hash && m.hash !== meta.abstract_hash) {
          findings.hashDrift.push({
            file: `${room.wing}/${room.hall}/${room.file}`,
            inRecord: meta.abstract_hash,
            inManifest: m.hash,
          });
        }
      }

      // Cold record check
      const ac = access[id];
      const created = meta.created ? new Date(meta.created).getTime() : null;
      if (created && ac && ac.total === 0) {
        const ageDays = (NOW - created) / 86400000;
        if (ageDays > COLD_DAYS) {
          findings.coldRecords.push({
            file: `${room.wing}/${room.hall}/${room.file}`,
            ageDays: Math.floor(ageDays),
          });
        }
      }
    } else if (room.kind === 'emb') {
      embByPath.add(room.fullPath);
    }
  }

  // Orphan .emb pass: every .emb must have a sibling .md
  for (const embPath of embByPath) {
    const mdPath = embPath.replace(/\.emb$/, '.md');
    if (!fs.existsSync(mdPath)) {
      findings.orphanEmb.push(path.relative(WINGS_DIR, embPath));
    }
  }

  // Duplicate IDs
  for (const [id, locations] of mdById) {
    if (locations.length > 1) {
      findings.duplicateIds.push({
        id,
        locations: locations.map(l => `${l.wing}/${l.hall}`),
      });
    }
  }

  const violations = checkInvariants();
  const invariantTotal = Object.values(violations).reduce((s, a) => s + a.length, 0);

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({
      generatedAt: new Date().toISOString(),
      totalRecords: total,
      invariants: violations,
      invariantViolationCount: invariantTotal,
      findings,
    }, null, 2));
    if (invariantTotal > 0) process.exit(1);
    return;
  }

  console.log(`Palace doctor — ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`);
  console.log(`${total} records examined  (tiny-body skipped: ${tinyBodySkipped})`);
  console.log('='.repeat(60));

  // ── v2.1 invariants — fail (gate exit code) ──
  console.log('Visibility invariants:');
  const invariantBlocks = [
    ['1. trust: low under wings/',                violations.trustLowInWings],
    ['2. review_required: true under wings/',     violations.reviewRequiredInWings],
    ['3. missing trust under wings/',             violations.missingTrustInWings],
    ['4. symlinks under any Palace root',         violations.symlinks],
    ['5. id present in both wings/ and quarantine', violations.idsInBothTrees],
    ['6. unparseable frontmatter',                violations.unparseableFrontmatter],
    ['7. injection_patterns under wings/ without last_action: promote', violations.injectionInWingsWithoutPromote],
  ];
  for (const [label, items] of invariantBlocks) {
    if (!items || items.length === 0) {
      console.log(`  ✓ ${label}: 0`);
      continue;
    }
    console.log(`  ✗ ${label}: ${items.length}`);
    for (const it of items.slice(0, 5)) console.log(`     ${typeof it === 'string' ? it : JSON.stringify(it)}`);
    if (items.length > 5) console.log(`     ... +${items.length - 5} more`);
  }
  console.log('');

  // ── Health checks — informational ──
  console.log('Health checks (informational):');
  const blocks = [
    ['Missing abstracts', findings.missingAbstract],
    ['Records missing .emb', findings.missingEmb],
    ['Orphan .emb files (no .md)', findings.orphanEmb],
    ['Hash drift (record vs manifest)', findings.hashDrift],
    ['Cold records (>90d, never accessed)', findings.coldRecords],
    ['Duplicate IDs across wings', findings.duplicateIds],
  ];

  let issues = 0;
  for (const [label, items] of blocks) {
    if (!items || items.length === 0) {
      console.log(`  ✓ ${label}: 0`);
      continue;
    }
    issues += items.length;
    console.log(`  ✗ ${label}: ${items.length}`);
    for (const it of items.slice(0, 5)) {
      if (typeof it === 'string') console.log(`     ${it}`);
      else console.log(`     ${JSON.stringify(it)}`);
    }
    if (items.length > 5) console.log(`     ... +${items.length - 5} more`);
  }

  console.log('='.repeat(60));
  if (invariantTotal > 0) {
    console.log(`FAIL: ${invariantTotal} invariant violation(s); ${issues} health issue(s).`);
    process.exit(1);
  }
  console.log(issues === 0 ? 'All clear.' : `Invariants OK; ${issues} health issue(s) (informational).`);
}

main();
