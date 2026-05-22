'use strict';

/**
 * palace-config.js — operator-specific config loader.
 *
 * PAL-MEM ships with a minimal default config so the framework runs out of
 * the box. Operators extend it by dropping a `config.json` at $PALACE_HOME
 * (default `~/.palace/config.json`). The config file is gitignored — it's
 * for per-machine, per-operator tuning that should never enter the public
 * repo.
 *
 * Recognized keys:
 *
 *   trustedSourcePrefixes : string[]  — additional prefixes to merge into
 *                                       palace-paths.js TRUSTED_SOURCE_PREFIXES.
 *                                       Strings ending in `:` or `-` act as
 *                                       prefixes; bare strings require exact
 *                                       match. See isTrustedSource().
 *
 *   typeMap               : array     — additional wing/hall → MemoryType
 *                                       mappings prepended to the default
 *                                       TYPE_MAP in palace-retrieval.js.
 *                                       Each entry: { pattern: "regex-source",
 *                                       type: "episodic|project|session|
 *                                       procedural|entity" }.
 *
 *   crossWingProjects     : object    — project → string[] of wings to also
 *                                       include in bootstrap projection. E.g.
 *                                       { "myproject": ["myproject", "meta"] }.
 *
 *   defaultTags           : string[]  — default tags for palace-api.js store.
 *
 *   wingsPath             : string    — absolute override for the wings root.
 *                                       Mostly useful when adopting PAL-MEM
 *                                       against an existing notes tree (see
 *                                       README "migration → custom system").
 *                                       Not consumed here; documented for
 *                                       completeness.
 *
 * The loader is best-effort: a missing file, malformed JSON, or
 * unrecognized key returns an empty object rather than throwing — the
 * framework continues with defaults. Errors go to stderr.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const PALACE_HOME = process.env.PALACE_HOME || path.join(os.homedir(), '.palace');
const CONFIG_FILE = path.join(PALACE_HOME, 'config.json');

let cached = null;

function load() {
  if (cached !== null) return cached;
  cached = {};
  if (!fs.existsSync(CONFIG_FILE)) return cached;
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') cached = parsed;
  } catch (e) {
    process.stderr.write(`[palace-config] failed to load ${CONFIG_FILE}: ${e.message}\n`);
  }
  return cached;
}

function trustedSourcePrefixes() {
  const cfg = load();
  return Array.isArray(cfg.trustedSourcePrefixes) ? cfg.trustedSourcePrefixes.filter(s => typeof s === 'string') : [];
}

function typeMap() {
  const cfg = load();
  if (!Array.isArray(cfg.typeMap)) return [];
  const out = [];
  for (const entry of cfg.typeMap) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.pattern !== 'string' || typeof entry.type !== 'string') continue;
    try {
      out.push({ match: new RegExp(entry.pattern), type: entry.type });
    } catch (e) {
      process.stderr.write(`[palace-config] invalid typeMap regex "${entry.pattern}": ${e.message}\n`);
    }
  }
  return out;
}

function crossWingProjects() {
  const cfg = load();
  return (cfg.crossWingProjects && typeof cfg.crossWingProjects === 'object') ? cfg.crossWingProjects : {};
}

function defaultTags() {
  const cfg = load();
  return Array.isArray(cfg.defaultTags) ? cfg.defaultTags.filter(s => typeof s === 'string') : [];
}

function reset() { cached = null; }

module.exports = {
  CONFIG_FILE,
  trustedSourcePrefixes,
  typeMap,
  crossWingProjects,
  defaultTags,
  reset,
};
