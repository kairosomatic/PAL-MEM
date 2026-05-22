#!/usr/bin/env node
'use strict';

/**
 * palace-ephemeral-sweep.js — Soft-archive ephemeral records past expires_at.
 *
 *   node palace-ephemeral-sweep.js [--dry-run] [--verbose]
 *
 * Walks ~/.palace/wings, reads frontmatter on every .md, and for each record
 * with `ephemeral: true` and `expires_at` in the past, moves the .md (and any
 * sibling .emb) into ~/.palace/archive/<wing>/<hall>/.
 *
 * Same archive path as palace_forget — fully reversible by hand.
 */

const fs    = require('fs');
const path  = require('path');
const paths = require('./palace-paths.js');

const PALACE_HOME = process.env.PALACE_HOME || path.join(process.env.HOME, '.palace');
// v2.1: ephemeral records can live under wings/ (published) or quarantine/wings/.
// Walk both roots; archive root chosen per-record by paths.archiveRootFor().
const ROOTS       = [paths.ROOTS.published, paths.ROOTS.quarantine];
const ARCHIVE_DIR = path.join(PALACE_HOME, 'archive');

const args    = new Set(process.argv.slice(2));
const dryRun  = args.has('--dry-run');
const verbose = args.has('--verbose');

function parseFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return {};
  const meta = {};
  let i = 1;
  while (i < lines.length && lines[i] !== '---') {
    const colonIdx = lines[i].indexOf(':');
    if (colonIdx !== -1) {
      meta[lines[i].slice(0, colonIdx).trim()] = lines[i].slice(colonIdx + 1).trim();
    }
    i++;
  }
  return meta;
}

function sweep() {
  const liveRoots = ROOTS.filter(r => fs.existsSync(r));
  if (!liveRoots.length) {
    console.log('No published or quarantine roots — nothing to sweep.');
    return;
  }

  const now = Date.now();
  let scanned = 0;
  let archived = 0;
  let live     = 0;
  let errors   = 0;

  for (const ROOT of liveRoots) {
    for (const wing of fs.readdirSync(ROOT)) {
    const wingDir = path.join(ROOT, wing);
    if (!fs.statSync(wingDir).isDirectory()) continue;

    for (const hall of fs.readdirSync(wingDir)) {
      const hallDir = path.join(wingDir, hall);
      if (!fs.statSync(hallDir).isDirectory()) continue;

      for (const file of fs.readdirSync(hallDir)) {
        if (!file.endsWith('.md')) continue;
        scanned++;
        const fullPath = path.join(hallDir, file);

        let meta;
        try { meta = parseFrontmatter(fs.readFileSync(fullPath, 'utf8')); }
        catch (e) { errors++; continue; }

        if (meta.ephemeral !== 'true') continue;
        if (!meta.expires_at) {
          if (verbose) console.warn(`  ?  ephemeral with no expires_at: ${wing}/${hall}/${file}`);
          continue;
        }
        const expTs = new Date(meta.expires_at).getTime();
        if (!Number.isFinite(expTs)) {
          if (verbose) console.warn(`  ?  invalid expires_at: ${wing}/${hall}/${file}`);
          continue;
        }
        if (expTs >= now) { live++; continue; }

        const targetDir  = path.join(ARCHIVE_DIR, wing, hall);
        const targetPath = path.join(targetDir, file);
        const embPath    = fullPath.replace(/\.md$/, '.emb');
        const embTarget  = targetPath.replace(/\.md$/, '.emb');

        if (dryRun) {
          console.log(`  [dry] would archive ${wing}/${hall}/${file} (expired ${meta.expires_at})`);
          archived++;
          continue;
        }

        try {
          fs.mkdirSync(targetDir, { recursive: true });
          fs.renameSync(fullPath, targetPath);
          if (fs.existsSync(embPath)) fs.renameSync(embPath, embTarget);
          archived++;
          if (verbose) console.log(`  ✓  archived ${wing}/${hall}/${file}`);
        } catch (e) {
          errors++;
          console.error(`  ✗  failed to archive ${wing}/${hall}/${file}: ${e.message}`);
        }
      }
    }
    }
  }

  console.log(`Ephemeral sweep ${dryRun ? '(dry-run) ' : ''}complete:`);
  console.log(`  scanned:  ${scanned}`);
  console.log(`  archived: ${archived}`);
  console.log(`  live:     ${live} (ephemeral but not yet expired)`);
  if (errors) console.log(`  errors:   ${errors}`);
}

sweep();
