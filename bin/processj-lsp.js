#!/usr/bin/env node
// Entry point for editors. Run with --stdio (default) or --node-ipc / --socket=PORT.
if (!process.argv.some((a) => a.startsWith('--stdio') || a.startsWith('--node-ipc') || a.startsWith('--socket') || a.startsWith('--pipe'))) {
  process.argv.push('--stdio');
}
require('../dist/src/server.js');
