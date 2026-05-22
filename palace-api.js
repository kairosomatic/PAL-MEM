#!/usr/bin/env node
'use strict';
// palace-api.js — JSON interface for bot.py (Python subprocess calls)
// Outputs JSON to stdout, errors to stderr, exit 1 on failure.
//
// Usage:
//   node palace-api.js search <query...>
//   node palace-api.js store <wing> <hall> <body...>
//   node palace-api.js recall <wing> <hall>
//   node palace-api.js summary [limit]

const palace = require('./palace.js');
const [,, cmd, ...args] = process.argv;

(async () => {
  try {
    let result;
    if (cmd === 'search') {
      result = await palace.search(args.join(' '), { limit: 5 });
    } else if (cmd === 'store') {
      const [wing, hall, ...bodyParts] = args;
      result = await palace.store(wing, hall, bodyParts.join(' '), ['telegram', 'diary'], {
        trust:  'medium',
        source: 'local-human',
      });
    } else if (cmd === 'recall') {
      const [wing, hall] = args;
      result = await palace.recall(wing, hall, { limit: 5 });
    } else if (cmd === 'summary') {
      result = await palace.summary(parseInt(args[0] || '10', 10));
    } else {
      process.stderr.write(`unknown command: ${cmd || '(none)'}\n`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (e) {
    process.stderr.write(e.message + '\n');
    process.exit(1);
  }
})();
