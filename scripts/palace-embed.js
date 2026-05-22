#!/usr/bin/env node
'use strict';

/**
 * palace-embed.js — Generate flat-binary .emb sidecars for Palace records.
 *
 * For every record with an `abstract:`, writes a 768-dim float32 binary file
 * alongside the .md (e.g. `r-1234.md` → `r-1234.emb`). Skips re-embed when
 * the record's `abstract_hash:` matches the hash stored in the sidecar's
 * companion JSON manifest.
 *
 * Run:
 *   node palace-embed.js [--limit N] [--wing W] [--model M] [--force]
 *
 * Flags:
 *   --limit N    process at most N records (default: all)
 *   --wing W     restrict to a specific wing
 *   --model M    Ollama embedding model (default: nomic-embed-text)
 *   --force      regenerate even if hash matches
 */

const fs    = require('fs');
const path  = require('path');
const http  = require('http');

const PALACE_HOME = process.env.PALACE_HOME || path.join(process.env.HOME, '.palace');
const WINGS_DIR   = path.join(PALACE_HOME, 'wings');
const MANIFEST    = path.join(PALACE_HOME, 'index', 'embeddings-manifest.json');

const ARGS    = process.argv.slice(2);
const argVal  = (f, d) => { const i = ARGS.indexOf(f); return i >= 0 ? ARGS[i + 1] : d; };
const LIMIT   = parseInt(argVal('--limit', '0'), 10) || Infinity;
const WING    = argVal('--wing', null);
const MODEL   = argVal('--model', 'nomic-embed-text');
const FORCE   = ARGS.includes('--force');

const OLLAMA_URL = process.env.OLLAMA_HOST || 'http://localhost:11434';

function parseFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { meta: {} };
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
  return { meta };
}

function ollamaEmbed(model, text) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ model, prompt: text });
    const url  = new URL('/api/embeddings', OLLAMA_URL);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            const obj = JSON.parse(buf);
            if (obj.error) return reject(new Error(obj.error));
            if (!Array.isArray(obj.embedding)) return reject(new Error('no embedding in response'));
            resolve(obj.embedding);
          } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Ollama embed timeout (30s)')));
    req.write(data);
    req.end();
  });
}

function* walkRooms(wing) {
  const wingDir = path.join(WINGS_DIR, wing);
  if (!fs.existsSync(wingDir)) return;
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

function listWings() {
  if (!fs.existsSync(WINGS_DIR)) return [];
  return fs.readdirSync(WINGS_DIR).filter(f => {
    try { return fs.statSync(path.join(WINGS_DIR, f)).isDirectory(); }
    catch { return false; }
  });
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST)) return {};
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); }
  catch { return {}; }
}

function saveManifest(m) {
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  const tmp = `${MANIFEST}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
  fs.renameSync(tmp, MANIFEST);
}

async function main() {
  const wings    = WING ? [WING] : listWings();
  const manifest = loadManifest();
  let processed  = 0;
  let skipped    = 0;
  let errors     = 0;
  const t0       = Date.now();

  for (const wing of wings) {
    for (const room of walkRooms(wing)) {
      if (processed >= LIMIT) break;

      let text;
      try { text = fs.readFileSync(room.fullPath, 'utf8'); }
      catch { errors++; continue; }

      const { meta } = parseFrontmatter(text);
      if (!meta.abstract) { skipped++; continue; }

      const recordId = meta.id || path.basename(room.file, '.md');
      const key      = `${wing}/${room.hall}/${recordId}`;
      const expectedHash = meta.abstract_hash || '';

      const embPath = room.fullPath.replace(/\.md$/, '.emb');
      const fresh   = manifest[key]
        && manifest[key].hash === expectedHash
        && fs.existsSync(embPath);

      if (fresh && !FORCE) { skipped++; continue; }

      let vec;
      try { vec = await ollamaEmbed(MODEL, meta.abstract); }
      catch (e) {
        console.error(`  ✗ ${key}  embed error: ${e.message}`);
        errors++;
        continue;
      }

      const buf = Buffer.alloc(vec.length * 4);
      for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
      const tmp = `${embPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, embPath);

      manifest[key] = {
        hash: expectedHash,
        dim: vec.length,
        model: MODEL,
        embedded_at: new Date().toISOString(),
      };

      processed++;
      console.log(`  ✓ ${key}  dim=${vec.length}`);
    }
    if (processed >= LIMIT) break;
  }

  saveManifest(manifest);

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('');
  console.log(`Done. processed=${processed} skipped=${skipped} errors=${errors} (${dt}s)`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
