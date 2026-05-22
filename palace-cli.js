#!/usr/bin/env node
'use strict';

const palace = require('./palace.js');
const fs     = require('fs');
const path   = require('path');

const [,, cmd, ...rawArgs] = process.argv;

// Parse flags and positional args
const flags      = {};
const positional = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i].startsWith('--')) {
    const key = rawArgs[i].slice(2);
    const next = rawArgs[i + 1];
    flags[key] = (next && !next.startsWith('--')) ? rawArgs[++i] : true;
  } else {
    positional.push(rawArgs[i]);
  }
}

const PALACE_HOME = process.env.PALACE_HOME || path.join(process.env.HOME, '.palace');
const CONTENT_ACCESS_LOG = path.join(PALACE_HOME, 'index', 'content-access.jsonl');

// ─── JSON record helpers (palace.bootstrap.v0) ──────────────────────────────

function logContentFullAccess(op, recordIds) {
  // Per spec §8 — track every full-content read so we can audit if every
  // harness is silently pulling whole bodies.
  try {
    fs.mkdirSync(path.dirname(CONTENT_ACCESS_LOG), { recursive: true });
    fs.appendFileSync(CONTENT_ACCESS_LOG, JSON.stringify({
      ts: new Date().toISOString(),
      op,
      mode: 'full',
      ids: recordIds,
    }) + '\n');
  } catch {}
}

function bodyExcerpt(body) {
  if (!body) return '';
  return body.split(/\s+/).slice(0, 200).join(' ');
}

function buildJsonRecord(it, contentMode, body) {
  const base = {
    id:              it.id,
    wing:            it.wing,
    hall:            it.hall,
    type:            it.type || null,
    bucket:          it.bucket || null,
    score:           it.score ?? null,
    trust:           it.trust ?? null,
    source:          it.source ?? null,
    review_required: it.reviewRequired ?? false,
    visibility:      it.visibility || (it.rawPath && it.rawPath.includes('/quarantine/') ? 'quarantine' : 'published'),
    path:            it.rawPath || null,
    updated:         it.updated || null,
    abstract:        it.abstract || '',
  };
  if (contentMode === 'full') {
    base.content = body || (it.body ?? null);
  } else if (contentMode === 'excerpt') {
    base.content = body ? bodyExcerpt(body) : (it.body ? bodyExcerpt(it.body) : null);
  } else {
    base.content = null;
  }
  return base;
}

async function emitJsonRecords({ op, query, retrievalFn, policy }, asJson) {
  const items = await retrievalFn();

  // For --content full|excerpt we need the body text. Hits already include
  // rawPath; load body lazily.
  let needsBody = policy.content_mode !== 'abstract';
  const records = items.map(it => {
    let body = null;
    if (needsBody && it.rawPath) {
      try {
        const text = fs.readFileSync(it.rawPath, 'utf8');
        const idx  = text.indexOf('\n---\n');
        body = idx >= 0 ? text.slice(idx + 5) : text;
      } catch {}
    }
    return buildJsonRecord(it, policy.content_mode, body);
  });

  if (policy.content_mode === 'full') {
    logContentFullAccess(op, records.map(r => r.id));
  }

  const out = {
    schema: 'palace.bootstrap.v0',
    schema_stable: false,
    op,
    query,
    generated_at: new Date().toISOString(),
    policy: {
      include_quarantine: policy.include_quarantine,
      roots: policy.include_quarantine ? ['wings', 'quarantine/wings'] : ['wings'],
      content_mode: policy.content_mode,
    },
    records,
  };
  if (asJson) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    console.log(`${op} ${JSON.stringify(query)}: ${records.length} records`);
    for (const r of records.slice(0, 10)) {
      console.log(`  ${r.id} (${r.visibility}) ${r.wing}/${r.hall} score=${r.score?.toFixed?.(3) ?? '-'} — ${(r.abstract || '').slice(0, 80)}`);
    }
  }
}

async function main() {
  switch (cmd) {

    case 'store': {
      const [wing, hall, ...bodyParts] = positional;
      if (!wing || !hall || !bodyParts.length) {
        console.error('Usage: palace store <wing> <hall> "<text>" [--tags tag1,tag2] [--trust high|medium|low] [--source <name>]');
        process.exit(1);
      }
      const body = bodyParts.join(' ');
      const tags = flags.tags ? flags.tags.split(',').map(t => t.trim()) : [];
      // CLI = operator. Default to medium/local-human; explicit flags override.
      const result = await palace.store(wing, hall, body, tags, {
        trust:  flags.trust  || 'medium',
        source: flags.source || 'local-human',
      });
      console.log(`Stored: ${result.id} → ${result.visibility}/${wing}/${hall}`);
      break;
    }

    case 'recall': {
      // v2.1 query-based recall: `--query <text> --json` uses the hybrid
      // retrieval engine and emits palace.bootstrap.v0 records.
      // Legacy wing/hall recall remains for shell users.
      if (flags.query || flags.json) {
        const retrieval = require('./scripts/palace-retrieval.js');
        const k     = parseInt(flags.k || flags.limit || '5', 10);
        const query = flags.query || positional.join(' ');
        if (!query) {
          if (flags.json) process.stderr.write('--query required for --json recall\n');
          else            console.error('Usage: palace recall --query "<text>" [--k 5] [--json] [--include-quarantine] [--content abstract|excerpt|full]');
          process.exit(2);
        }
        const includeQuarantine = !!flags['include-quarantine'];
        const contentMode       = flags.content || 'abstract';
        await emitJsonRecords({
          op: 'recall', query, retrievalFn: () => retrieval.recall(query, {
            k, includeQuarantine, accessType: 'recall',
          }),
          policy: { include_quarantine: includeQuarantine, content_mode: contentMode },
        }, flags.json);
        break;
      }

      const [wing, hall] = positional;
      if (!wing || !hall) {
        console.error('Usage: palace recall <wing> <hall> [--limit 10]    # legacy mode');
        console.error('       palace recall --query "<text>" [--k 5] [--json] [--include-quarantine]');
        process.exit(1);
      }
      const limit = parseInt(flags.limit || '10', 10);
      const rooms = await palace.recall(wing, hall, { limit });
      if (!rooms.length) { console.log('No rooms found.'); break; }
      rooms.forEach(r => {
        console.log(`[${r.created}] [${r.tags.join(', ')}]`);
        console.log(`  ${r.body.slice(0, 140)}`);
        console.log();
      });
      break;
    }

    case 'bootstrap': {
      // palace bootstrap --project <name> --max-tokens <n> [--branch <b>] --json [--include-quarantine] [--content abstract|excerpt|full]
      const retrieval = require('./scripts/palace-retrieval.js');
      const project   = flags.project || null;
      const branch    = flags.branch  || null;
      const maxTokens = parseInt(flags['max-tokens'] || '2000', 10);
      const includeQuarantine = !!flags['include-quarantine'];
      const contentMode       = flags.content || 'abstract';

      const result = await retrieval.bootstrap({
        project, branch, maxTokens, includeQuarantine,
      });

      const records = result.items.map(it => buildJsonRecord(it, contentMode));
      const out = {
        schema: 'palace.bootstrap.v0',
        schema_stable: false,
        project: { name: project, branch },
        generated_at: new Date().toISOString(),
        policy: {
          include_quarantine: includeQuarantine,
          roots: includeQuarantine ? ['wings', 'quarantine/wings'] : ['wings'],
          max_tokens: maxTokens,
          content_mode: contentMode,
        },
        counts: result.counts,
        token_count: result.tokenCount,
        records,
      };
      if (flags.json) process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      else {
        console.log(`Bootstrap: ${records.length} records (project=${project || 'all'}, branch=${branch || 'none'}, tokens=${result.tokenCount}/${maxTokens})`);
        for (const r of records) {
          console.log(`  [${r.bucket}] ${r.wing}/${r.hall}/${r.id} (${r.visibility}) — ${r.abstract.slice(0, 80)}`);
        }
      }
      break;
    }

    case 'search': {
      const query = positional.join(' ');
      if (!query) { console.error('Usage: palace search "<query>" [--wings w1,w2]'); process.exit(1); }
      const wings           = flags.wings ? flags.wings.split(',') : [];
      const includeSessions = !!flags['include-sessions'];
      const results         = await palace.search(query, { wings, includeSessions });
      if (!results.length) { console.log('No results.'); break; }
      results.forEach(r => {
        console.log(`[${r.wing}/${r.hall}] [${r.created}]`);
        console.log(`  ${r.body.slice(0, 140)}`);
        console.log();
      });
      break;
    }

    case 'summary': {
      const limit  = parseInt(flags.limit || '20', 10);
      const cacheTtl = flags['cache-ttl'] ? parseInt(flags['cache-ttl'], 10) : 0;

      // TTL cache check — skip injection if recently done this session
      if (flags.inject && cacheTtl > 0) {
        const cacheFile = path.join(PALACE_HOME, 'index', '.session-cache');
        if (fs.existsSync(cacheFile)) {
          const age = (Date.now() - fs.statSync(cacheFile).mtimeMs) / 1000;
          if (age < cacheTtl) {
            // Already injected recently — stay silent
            break;
          }
        }
      }

      const rooms = await palace.summary(limit);
      if (!rooms.length) { console.log('Palace is empty.'); break; }

      if (flags.inject) {
        // Update cache timestamp
        if (cacheTtl > 0) {
          const cacheFile = path.join(PALACE_HOME, 'index', '.session-cache');
          fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
          fs.writeFileSync(cacheFile, new Date().toISOString(), 'utf8');
        }
        console.log('\n[Palace — recent context]');
        rooms.forEach(r => console.log(`• ${r.wing}/${r.hall}: ${r.body.slice(0, 100)} (${r.created})`));
        console.log();
      } else {
        rooms.forEach(r => console.log(`[${r.created}] ${r.wing}/${r.hall}: ${r.body.slice(0, 120)}`));
      }
      break;
    }

    case 'ls': {
      const wingsDir = path.join(PALACE_HOME, 'wings');
      if (!fs.existsSync(wingsDir)) { console.log('Palace is empty.'); break; }
      const wings = fs.readdirSync(wingsDir).filter(f =>
        fs.statSync(path.join(wingsDir, f)).isDirectory()
      );
      for (const wing of wings) {
        const wingDir = path.join(wingsDir, wing);
        let total = 0;
        for (const hall of fs.readdirSync(wingDir)) {
          const hallDir = path.join(wingDir, hall);
          if (!fs.statSync(hallDir).isDirectory()) continue;
          const count = fs.readdirSync(hallDir).filter(f => f.endsWith('.md')).length;
          if (count) { console.log(`  ${wing}/${hall}: ${count}`); total += count; }
        }
        if (total) console.log(`${wing}: ${total} total`);
      }
      break;
    }

    case 'recent': {
      const limit = parseInt(flags.limit || '20', 10);
      const rooms = await palace.summary(limit);
      if (!rooms.length) { console.log('Palace is empty.'); break; }
      rooms.forEach(r => console.log(`[${r.created}] ${r.wing}/${r.hall}: ${r.body.slice(0, 100)}`));
      break;
    }

    case 'map': {
      console.log('Heat map available in v2. Use `palace ls` for current wing/hall counts.');
      break;
    }

    case 'proposals': {
      const approveId = flags['approve'];
      const rejectId  = flags['reject'];
      const reason    = flags['reason'] || '';

      if (approveId) {
        const room = await palace.getRoom('research', 'experiments', approveId);
        if (!room) { console.error(`Room not found: ${approveId}`); process.exit(1); }
        const today   = new Date().toISOString().slice(0, 10);
        const newBody = room.body.replace(/\nStatus:[^\n]*/g, '') + `\nApproved: ${today}`;
        const newTags = (room.tags || []).filter(t => t !== 'pending').concat('approved');
        await palace.updateRoom('research', 'experiments', approveId, { body: newBody, tags: newTags });
        console.log(`Approved: ${approveId}`);
        break;
      }

      if (rejectId) {
        if (!reason) {
          console.error('--reason is required for --reject. Example: palace proposals --reject <id> --reason "not enough data"');
          process.exit(1);
        }
        const room = await palace.getRoom('research', 'experiments', rejectId);
        if (!room) { console.error(`Room not found: ${rejectId}`); process.exit(1); }
        const today   = new Date().toISOString().slice(0, 10);
        const suffix  = reason ? ` — ${reason}` : '';
        const newBody = room.body.replace(/\nStatus:[^\n]*/g, '') + `\nRejected: ${today}${suffix}`;
        const newTags = (room.tags || []).filter(t => t !== 'pending').concat('rejected');
        await palace.updateRoom('research', 'experiments', rejectId, { body: newBody, tags: newTags });
        console.log(`Rejected: ${rejectId}`);
        break;
      }

      // Default: list all proposals grouped by status
      const all      = await palace.recall('research', 'experiments', { limit: 100 });
      const pending  = all.filter(r => r.tags && r.tags.includes('pending'));
      const approved = all.filter(r => r.tags && r.tags.includes('approved'));
      const rejected = all.filter(r => r.tags && r.tags.includes('rejected'));

      if (!all.length) { console.log('No proposals yet.'); break; }

      if (pending.length) {
        console.log(`\n── Pending (${pending.length}) ─────────────────────────`);
        for (const p of pending) {
          console.log(`\n[${p.id}]  ${p.created}`);
          console.log(p.body);
          console.log('  Usage: palace proposals --approve ' + p.id);
          console.log('         palace proposals --reject ' + p.id + ' --reason "<reason>"');
        }
      } else {
        console.log('No pending proposals.');
      }

      if (approved.length) {
        console.log(`\n── Approved (${approved.length}) ────────────────────────`);
        for (const p of approved) console.log(`  [${p.id}] ${p.body.slice(0, 80)}`);
      }
      if (rejected.length) {
        console.log(`\n── Rejected (${rejected.length}) ────────────────────────`);
        for (const p of rejected) console.log(`  [${p.id}] ${p.body.slice(0, 80)}`);
      }
      break;
    }

    case 'archive': {
      const { execSync } = require('child_process');
      execSync(`bash "${path.join(PALACE_HOME, 'scripts', 'archive.sh')}"`, { stdio: 'inherit' });
      break;
    }

    case 'doctor': {
      const { execFileSync } = require('child_process');
      const args = flags.json ? ['--json'] : [];
      execFileSync('node', [path.join(PALACE_HOME, 'scripts', 'palace-doctor.js'), ...args], { stdio: 'inherit' });
      break;
    }

    case 'index': {
      const sub = positional[0];
      const { execFileSync } = require('child_process');
      if (sub === 'rebuild') {
        execFileSync('node', [path.join(PALACE_HOME, 'scripts', 'palace-index.js')], { stdio: 'inherit' });
      } else {
        console.error('Usage: palace index rebuild');
        process.exit(1);
      }
      break;
    }

    case 'abstract': {
      const { execFileSync } = require('child_process');
      const args = [];
      if (flags.limit) args.push('--limit', String(flags.limit));
      if (flags.wing)  args.push('--wing',  String(flags.wing));
      if (flags.model) args.push('--model', String(flags.model));
      if (flags['dry-run']) args.push('--dry-run');
      if (flags.force) args.push('--force');
      execFileSync('node', [path.join(PALACE_HOME, 'scripts', 'palace-abstract.js'), ...args], { stdio: 'inherit' });
      break;
    }

    case 'embed': {
      const { execFileSync } = require('child_process');
      const args = [];
      if (flags.limit) args.push('--limit', String(flags.limit));
      if (flags.wing)  args.push('--wing',  String(flags.wing));
      if (flags.model) args.push('--model', String(flags.model));
      if (flags.force) args.push('--force');
      execFileSync('node', [path.join(PALACE_HOME, 'scripts', 'palace-embed.js'), ...args], { stdio: 'inherit' });
      break;
    }

    case 'stats': {
      if (flags.json) {
        const retrieval = require('./scripts/palace-retrieval.js');
        retrieval.load();
        const out = {
          schema: 'palace.stats.v0',
          schema_stable: false,
          generated_at: new Date().toISOString(),
          ...retrieval.stats(),
        };
        process.stdout.write(JSON.stringify(out, null, 2) + '\n');
        break;
      }
      const { execFileSync } = require('child_process');
      execFileSync('node', [path.join(PALACE_HOME, 'scripts', 'palace-access.js'), 'stats'], { stdio: 'inherit' });
      break;
    }

    case 'serve': {
      // Foreground server (for dev). Use `palace serve --background` for nohup.
      const { spawn } = require('child_process');
      const serverScript = path.join(PALACE_HOME, 'scripts', 'pal-server.js');
      const port = flags.port || '7432';
      const env = { ...process.env, PAL_PORT: String(port) };

      if (flags.background) {
        const logFile = path.join(PALACE_HOME, 'logs', 'pal-server.log');
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        const out = fs.openSync(logFile, 'a');
        const err = fs.openSync(logFile, 'a');
        const child = spawn('node', [serverScript], {
          detached: true, stdio: ['ignore', out, err], env,
        });
        child.unref();
        const pidFile = path.join(PALACE_HOME, 'logs', 'pal-server.pid');
        fs.writeFileSync(pidFile, String(child.pid));
        console.log(`pal-server started in background (PID ${child.pid}, port ${port})`);
        console.log(`  logs: ${logFile}`);
        console.log(`  pid:  ${pidFile}`);
      } else {
        const child = spawn('node', [serverScript], { stdio: 'inherit', env });
        child.on('exit', code => process.exit(code || 0));
      }
      break;
    }

    case 'stop': {
      const pidFile = path.join(PALACE_HOME, 'logs', 'pal-server.pid');
      if (!fs.existsSync(pidFile)) {
        console.error('No pal-server.pid file found.');
        process.exit(1);
      }
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      try { process.kill(pid, 'SIGTERM'); console.log(`Sent SIGTERM to pal-server (PID ${pid})`); }
      catch (e) { console.error(`Could not signal PID ${pid}: ${e.message}`); }
      try { fs.unlinkSync(pidFile); } catch {}
      break;
    }

    case 'promote':
    case 'demote':
    case 'quarantine':
    case 'restore': {
      const { execFileSync } = require('child_process');
      const promoteScript = path.join(PALACE_HOME, 'scripts', 'palace-promote.js');
      const args = [cmd, ...rawArgs];
      try {
        execFileSync('node', [promoteScript, ...args], { stdio: 'inherit' });
      } catch (e) {
        process.exit(e.status || 1);
      }
      break;
    }

    case 'onboard': {
      const { execFileSync } = require('child_process');
      const onboardScript = path.join(PALACE_HOME, 'scripts', 'palace-onboard.js');
      try {
        execFileSync('node', [onboardScript, ...rawArgs], { stdio: 'inherit' });
      } catch (e) {
        process.exit(e.status || 1);
      }
      break;
    }

    case 'migrate': {
      const { execFileSync } = require('child_process');
      const migrateScript = path.join(PALACE_HOME, 'scripts', 'palace-migrate.js');
      const args = [];
      if (flags['dry-run']) args.push('--dry-run');
      if (flags.apply)      args.push('--apply');
      if (!args.length) {
        console.error('Usage: palace migrate --dry-run | --apply');
        process.exit(2);
      }
      execFileSync('node', [migrateScript, ...args], { stdio: 'inherit' });
      break;
    }

    case 'ephemeral-sweep': {
      const { execFileSync } = require('child_process');
      const sweepScript = path.join(PALACE_HOME, 'scripts', 'palace-ephemeral-sweep.js');
      const sweepArgs = [];
      if (flags['dry-run']) sweepArgs.push('--dry-run');
      if (flags.verbose)    sweepArgs.push('--verbose');
      execFileSync('node', [sweepScript, ...sweepArgs], { stdio: 'inherit' });
      break;
    }

    case 'serve-status': {
      const http = require('http');
      const port = flags.port || '7432';
      http.get(`http://127.0.0.1:${port}/health`, res => {
        let buf = '';
        res.on('data', c => (buf += c));
        res.on('end', () => console.log(buf));
      }).on('error', e => {
        console.error(`pal-server not reachable on port ${port}: ${e.message}`);
        process.exit(1);
      });
      break;
    }

    default: {
      console.log(`palace <command> [options]

Commands:
  store <wing> <hall> "<text>" [--tags tag1,tag2]
  recall <wing> <hall> [--limit 10]
  search "<query>" [--wings w1,w2] [--include-sessions]
  summary [--limit 20] [--inject]
  ls
  recent [--limit 20]
  map
  proposals                           # list routing proposals from nightly loop
  proposals --approve <id>            # approve a proposal
  proposals --reject <id> --reason "x" # reject with reason
  archive
  doctor [--json]                     # PAL: health check (missing abstracts, hash drift, etc.)
  index rebuild                       # PAL: rebuild lemmatized keyword index
  abstract [--limit N] [--wing W] [--force]   # PAL: generate abstracts via Ollama
  embed [--limit N] [--wing W] [--force]      # PAL: generate .emb sidecars
  stats                               # PAL: access counter stats
  serve [--port 7432] [--background]  # PAL: start REST API
  stop                                # PAL: stop background pal-server
  serve-status [--port 7432]          # PAL: ping /health on running server
  ephemeral-sweep [--dry-run] [--verbose]  # PAL: archive expired ephemeral records
  migrate --dry-run | --apply         # PAL v2.1: stamp legacy records with trust/source provenance
  bootstrap --project <name> --max-tokens <n> --json [--include-quarantine] [--content abstract|excerpt|full]
  recall --query "<text>" [--k 5] [--json] [--include-quarantine] [--content abstract|excerpt|full]
  stats [--json]                      # PAL v2.1: corpus visibility + trust counts via retrieval engine
  promote <id> --trust high|medium --reviewed-by <name> --reason "<text ≥12 chars>"
  demote <id> --trust low --reason "<text>"
  quarantine <id> --reason "<text>"
  restore <id>                        # un-archive; re-runs defaultVisibility() against current policy
  onboard <source-dir> --target-wing <w> --target-hall <h> [--dry-run|--apply] [--include-trusted]`);
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
