#!/usr/bin/env node
'use strict';

/**
 * palace-index.js — Build lemmatized keyword index for Palace records.
 *
 * Per PAL spec: stop-word filter + PorterStemmer lemmatization, no tier
 * weights, no multi-match amplification. Writes to:
 *   ~/.palace/index/keyword-index-v2.json
 *
 * Index structure:
 *   { "<lemma>": { rooms: [{ wing, hall, id, tf }] } }
 *
 * Run:
 *   node palace-index.js [--rebuild]
 *
 * --rebuild   delete and recreate from scratch (default: incremental rebuild)
 */

const fs   = require('fs');
const path = require('path');
const natural = require('natural');

const PALACE_HOME = process.env.PALACE_HOME || path.join(process.env.HOME, '.palace');
const WINGS_DIR   = path.join(PALACE_HOME, 'wings');
const INDEX_FILE  = path.join(PALACE_HOME, 'index', 'keyword-index-v2.json');

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

function tokenize(text) {
  return text.toLowerCase().match(/[a-z][a-z0-9_-]{1,}/g) || [];
}

function lemmasOf(text) {
  const counts = new Map();
  for (const tok of tokenize(text)) {
    if (STOP_WORDS.has(tok)) continue;
    if (tok.length < 3) continue;
    const root = stemmer.stem(tok);
    counts.set(root, (counts.get(root) || 0) + 1);
  }
  return counts;
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
        yield { wing, hall, file, fullPath: path.join(hallDir, file) };
      }
    }
  }
}

function main() {
  const t0 = Date.now();
  const index = {};  // lemma → [{ wing, hall, id, tf }]
  let rooms = 0;
  let lemmas = 0;

  for (const room of walkAllRooms()) {
    let text;
    try { text = fs.readFileSync(room.fullPath, 'utf8'); }
    catch { continue; }
    const { meta, body } = parseFrontmatter(text);
    const recordId = meta.id || path.basename(room.file, '.md');

    // Index: title (tags) + abstract + body
    const corpus = [
      meta.tags || '',
      meta.abstract || '',
      body || '',
    ].join(' ');

    const counts = lemmasOf(corpus);
    rooms++;

    for (const [lemma, tf] of counts) {
      if (!index[lemma]) {
        index[lemma] = { rooms: [] };
        lemmas++;
      }
      index[lemma].rooms.push({
        wing: room.wing,
        hall: room.hall,
        id: recordId,
        tf,
      });
    }
  }

  fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
  const tmp = `${INDEX_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index));
  fs.renameSync(tmp, INDEX_FILE);

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const size = (fs.statSync(INDEX_FILE).size / 1024).toFixed(1);
  console.log(`Indexed ${rooms} rooms → ${lemmas} lemmas (${size} KB, ${dt}s)`);
  console.log(`Index: ${INDEX_FILE}`);
}

main();
