#!/usr/bin/env node
'use strict';

/**
 * palace-abstract.js — Generate abstracts for Palace records (PAL Phase 1).
 *
 * Walks all wings/halls/rooms, finds records missing an `abstract:` field
 * in frontmatter, and generates one via local Ollama. Writes the abstract
 * back to the record atomically. Also stamps `abstract_hash:` so downstream
 * embedding can decide whether to re-embed.
 *
 * Run:
 *   node palace-abstract.js [--limit N] [--wing W] [--model M] [--dry-run] [--force]
 *
 * Flags:
 *   --limit N    process at most N records (default: all)
 *   --wing W     restrict to a specific wing (default: all)
 *   --model M    Ollama model (default: llama3.2)
 *   --dry-run    show what would change, don't write
 *   --force      regenerate even if abstract already exists
 */

const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const http     = require('http');

const PALACE_HOME = process.env.PALACE_HOME || path.join(process.env.HOME, '.palace');
const WINGS_DIR   = path.join(PALACE_HOME, 'wings');

const ARGS    = process.argv.slice(2);
const idxOf   = (f) => ARGS.indexOf(f);
const argVal  = (f, dflt) => idxOf(f) >= 0 ? ARGS[idxOf(f) + 1] : dflt;
const LIMIT   = parseInt(argVal('--limit', '0'), 10) || Infinity;
const WING    = argVal('--wing', null);
const MODEL   = argVal('--model', 'llama3.2');
const DRY_RUN = ARGS.includes('--dry-run');
const FORCE   = ARGS.includes('--force');

const OLLAMA_URL = process.env.OLLAMA_HOST || 'http://localhost:11434';

// ─── Frontmatter parsing ────────────────────────────────────────────────────

function parseFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { meta: {}, body: text, frontmatterEndLine: -1 };
  let i = 1;
  const meta = {};
  let multilineKey = null;
  let multilineValue = [];
  while (i < lines.length && lines[i] !== '---') {
    const line = lines[i];
    if (multilineKey !== null) {
      // Collect lines until we hit a non-indented line
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
    if (val === '|' || val === '>') {
      multilineKey = key;
      multilineValue = [];
    } else {
      meta[key] = val;
    }
    i++;
  }
  if (multilineKey !== null) {
    meta[multilineKey] = multilineValue.join('\n').trim();
  }
  if (i >= lines.length) return { meta: {}, body: text, frontmatterEndLine: -1 };
  return { meta, body: lines.slice(i + 1).join('\n'), frontmatterEndLine: i };
}

function buildFrontmatter(meta) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    if (v == null) continue;
    if (typeof v === 'string' && v.includes('\n')) {
      lines.push(`${k}: |`);
      for (const part of v.split('\n')) lines.push(`  ${part}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

// ─── Ollama ────────────────────────────────────────────────────────────────

function ollamaGenerate(model, prompt) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { temperature: 0.2, num_predict: 280 },
    });
    const url = new URL('/api/generate', OLLAMA_URL);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let buf = '';
        res.on('data', (chunk) => (buf += chunk));
        res.on('end', () => {
          try {
            const obj = JSON.parse(buf);
            if (obj.error) return reject(new Error(obj.error));
            resolve((obj.response || '').trim());
          } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('Ollama request timeout (60s)')));
    req.write(data);
    req.end();
  });
}

function buildPrompt({ wing, hall, type, created, body }) {
  const typeLabel = type || 'note';
  return `You write ultra-compact abstracts for an agent memory system. Output a single abstract for the record below. Hard limits: at most 200 tokens, no preamble, no markdown headings, no bullet points, plain prose only.

Format:
[${typeLabel.toUpperCase()}] ${wing}/${hall} ${created}
One or two sentences: what this is, why it matters, key entities.
Key facts: fact1; fact2; fact3.

Record body:
"""
${body.trim().slice(0, 4000)}
"""

Abstract:`;
}

// ─── Walking ───────────────────────────────────────────────────────────────

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

function writeAtomic(filePath, content) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const wings = WING ? [WING] : listWings();
  let processed = 0;
  let skipped   = 0;
  let errors    = 0;
  const t0 = Date.now();

  for (const wing of wings) {
    for (const room of walkRooms(wing)) {
      if (processed >= LIMIT) break;

      let text;
      try { text = fs.readFileSync(room.fullPath, 'utf8'); }
      catch (e) { errors++; continue; }

      const { meta, body } = parseFrontmatter(text);
      if (!body || body.trim().length < 20) { skipped++; continue; }

      if (meta.abstract && !FORCE) { skipped++; continue; }

      const prompt = buildPrompt({
        wing,
        hall: room.hall,
        type: meta.type || 'note',
        created: meta.created || 'unknown',
        body,
      });

      let abstract;
      try {
        abstract = await ollamaGenerate(MODEL, prompt);
      } catch (e) {
        console.error(`  ✗ ${room.fullPath}  Ollama error: ${e.message}`);
        errors++;
        continue;
      }

      if (!abstract || abstract.length < 20) {
        console.error(`  ✗ ${room.fullPath}  empty abstract`);
        errors++;
        continue;
      }

      const abstractHash = crypto.createHash('sha256').update(abstract).digest('hex').slice(0, 16);

      const newMeta = {
        ...meta,
        abstract,
        abstract_hash: abstractHash,
        abstract_model: MODEL,
        abstract_at: new Date().toISOString(),
      };
      const newContent = `${buildFrontmatter(newMeta)}\n${body}`;

      processed++;
      const tag = DRY_RUN ? '[DRY]' : '✓';
      const tokenEstimate = Math.ceil(abstract.length / 4);
      console.log(`  ${tag} ${wing}/${room.hall}/${room.file}  (~${tokenEstimate}t)`);

      if (!DRY_RUN) {
        try { writeAtomic(room.fullPath, newContent); }
        catch (e) {
          console.error(`     write failed: ${e.message}`);
          errors++;
        }
      }
    }
    if (processed >= LIMIT) break;
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('');
  console.log(`Done. processed=${processed} skipped=${skipped} errors=${errors} (${dt}s)`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
