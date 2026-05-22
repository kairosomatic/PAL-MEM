'use strict';

/**
 * palace-trust.js — PAL Phase 4 trust model.
 *
 * Three concerns at write time:
 *   1. Secret redaction — strip API keys, tokens, passwords before storage.
 *   2. Prompt-injection detection — flag suspicious patterns for review.
 *   3. Trust labels — record trust/source/ephemeral on every write.
 *
 * Sanitizer. Two-tier:
 *   - Always redact known key formats (Anthropic, Discord, Google, GitHub, Slack, AWS, OpenAI).
 *   - Context-triggered redaction: generic password/token values when the line
 *     mentions a setup context (server, login, config, etc.) — prevents card IDs
 *     and hex prices from being incorrectly redacted.
 */

const CONTEXT_TRIGGER = /\b(server|profile|account|login|setup|credentials?|config|host|instance|env|connection|auth|secret|api)\b/i;

// ─── Secret redaction ──────────────────────────────────────────────────────

function sanitizeSecrets(text) {
  if (!text) return { text, hits: [] };
  const hits = [];
  const note = (label) => hits.push(label);

  let out = text;

  // Always redact — high-confidence key formats
  out = out.replace(/sk-ant-api\w{2}-[\w-]{20,}/g,            (_) => { note('ANTHROPIC_KEY');  return '[ANTHROPIC_KEY]';  });
  out = out.replace(/MTQ[\w.]{30,}/g,                          (_) => { note('DISCORD_TOKEN'); return '[DISCORD_TOKEN]'; });
  out = out.replace(/GOCSPX-[\w-]{20,}/g,                      (_) => { note('GOOGLE_SECRET'); return '[GOOGLE_SECRET]'; });
  out = out.replace(/ghp_[A-Za-z0-9]{36}/g,                    (_) => { note('GITHUB_TOKEN');  return '[GITHUB_TOKEN]';  });
  out = out.replace(/xox[bpors]-[\w-]{10,}/g,                  (_) => { note('SLACK_TOKEN');   return '[SLACK_TOKEN]';   });
  out = out.replace(/AKIA[0-9A-Z]{16}/g,                       (_) => { note('AWS_ACCESS_KEY'); return '[AWS_ACCESS_KEY]'; });
  out = out.replace(/sk-proj-[A-Za-z0-9_-]{40,}/g,             (_) => { note('OPENAI_KEY');    return '[OPENAI_KEY]';    });

  // Context-triggered: only redact value-like strings when line has a setup context word
  out = out.split('\n').map(line => {
    if (!CONTEXT_TRIGGER.test(line)) return line;
    line = line.replace(/\b(password|passwd|pwd)\s*[=:]\s*\S+/gi,                          (_, k) => { note('PASSWORD'); return `${k}=[PASSWORD]`; });
    line = line.replace(/\b(token|secret|api[_-]?key|client[_-]?secret)\s*[=:]\s*\S+/gi,    (_, k) => { note('SECRET');   return `${k}=[SECRET]`;   });
    line = line.replace(/\b(key)\s*[=:]\s*[A-Za-z0-9/+]{20,}={0,2}\b/g,                     (_, k) => { note('KEY');      return `${k}=[KEY]`;      });
    return line;
  }).join('\n');

  return { text: out, hits };
}

// ─── Prompt-injection detection ─────────────────────────────────────────────

const INJECTION_PATTERNS = [
  { name: 'ignore_previous',         re: /\b(ignore|disregard|forget)\s+(all\s+)?(previous|above|prior|earlier|the\s+above)\s+(instructions?|prompts?|rules?|context|messages?)/i },
  { name: 'override_system',         re: /\b(override|replace|bypass|update)\s+(your\s+)?(system|prior|previous)\s+(prompt|instructions?|rules?)/i },
  { name: 'role_hijack_assistant',   re: /\b(you\s+are\s+now|act\s+as|pretend\s+to\s+be|from\s+now\s+on\s+you\s+are)\s+a?\s*(different|new|another|jailbroken|uncensored|developer|admin|sudo)/i },
  { name: 'injected_role_tag',       re: /<\|?\s*(system|user|assistant|im_start|im_end)\s*\|?>/i },
  { name: 'fake_anthropic_directive',re: /\b(claude|anthropic)\s*(api)?\s*[:>-]+\s*(new\s+)?(instruction|directive|policy|update)/i },
  { name: 'tool_invocation_inline',  re: /<(tool_use|invoke|function_calls)[\s>]/i },
  { name: 'palace_tool_in_body',     re: /\bpalace_(remember|forget|recall|bootstrap|search)\s*\(/i },
  { name: 'exfiltrate',              re: /\b(send|post|exfiltrate|leak|forward)\s+(this|memory|all\s+records|the\s+corpus|secrets?|credentials?|the\s+key)/i },
  { name: 'system_prompt_extract',   re: /\b(reveal|print|show|dump)\s+(your\s+)?(system\s+prompt|hidden\s+instructions?|original\s+prompt|the\s+rules)/i },
  { name: 'jailbreak_keyword',       re: /\b(DAN|do\s+anything\s+now|jailbreak|prompt\s+injection)\b/i },
];

function detectInjection(text) {
  if (!text) return { flagged: false, patterns: [] };
  const matches = [];
  for (const p of INJECTION_PATTERNS) {
    if (p.re.test(text)) matches.push(p.name);
  }
  return { flagged: matches.length > 0, patterns: matches };
}

// ─── Trust labels ──────────────────────────────────────────────────────────

const VALID_TRUST = new Set(['high', 'medium', 'low']);

/**
 * normalizeTrust(value) → 'high' | 'medium' | 'low' | null
 *
 * Returns null for missing/unrecognized values. v2.1 closes the silent-default
 * loophole: callers must declare trust explicitly. Records with trust=null
 * route to quarantine via defaultVisibility().
 */
function normalizeTrust(value) {
  if (value == null || value === '') return null;
  const v = String(value).toLowerCase();
  return VALID_TRUST.has(v) ? v : null;
}

function expiryFromTtl(ttlDays) {
  const days = Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : 7;
  const ms = days * 86400000;
  return new Date(Date.now() + ms).toISOString();
}

function isExpired(record) {
  if (!record) return false;
  if (record.meta?.ephemeral !== 'true' && !record.ephemeral) return false;
  const exp = record.meta?.expires_at || record.expires_at;
  if (!exp) return false;
  const t = new Date(exp).getTime();
  return Number.isFinite(t) && t < Date.now();
}

// ─── Display prefixes ──────────────────────────────────────────────────────

function displayPrefix(meta) {
  const parts = [];
  if (meta?.review_required === 'true') parts.push('[PENDING REVIEW]');
  if (meta?.trust === 'low') parts.push('[UNTRUSTED SOURCE]');
  return parts.length ? parts.join(' ') + ' ' : '';
}

module.exports = {
  sanitizeSecrets,
  detectInjection,
  normalizeTrust,
  expiryFromTtl,
  isExpired,
  displayPrefix,
  INJECTION_PATTERNS,
};
