#!/usr/bin/env node
// Builds the language server from the repository root, copies it into vscode/server/
// (with its runtime dependencies), and compiles the extension.
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const here = path.resolve(__dirname, '..');
const root = path.resolve(here, '..');
const run = (cmd, cwd) => {
  console.log(`$ ${cmd}   (in ${path.relative(root, cwd) || '.'})`);
  execSync(cmd, { cwd, stdio: 'inherit' });
};

run('npm install', root);
run('npm run build', root);

const server = path.join(here, 'server');
fs.rmSync(server, { recursive: true, force: true });
fs.mkdirSync(path.join(server, 'dist'), { recursive: true });
fs.cpSync(path.join(root, 'bin'), path.join(server, 'bin'), { recursive: true });
fs.cpSync(path.join(root, 'dist', 'src'), path.join(server, 'dist', 'src'), { recursive: true });
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(server, 'package.json'), JSON.stringify({ name: 'processj-lsp-server', private: true, main: 'dist/src/server.js', dependencies: rootPkg.dependencies }, null, 2));
run('npm install --omit=dev --no-audit --no-fund', server);

run('npm install --no-audit --no-fund', here);
run('npx tsc -p tsconfig.json', here);
console.log('\nBuilt. Next: `npm run package` for a .vsix, or `npm run install-extension` to install it into VS Code.');
