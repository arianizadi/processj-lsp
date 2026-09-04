#!/usr/bin/env node
// Builds the language server from the repository root, copies it into vscode/server/
// (with its runtime dependencies), and compiles the extension.
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const here = path.resolve(__dirname, '..');
const root = path.resolve(here, '..');
// VSIX packaging only sees files below vscode/, so include repository notices explicitly.
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(here, 'LICENSE'));
fs.copyFileSync(path.join(root, 'NOTICE'), path.join(here, 'NOTICE'));
const run = (cmd, cwd) => {
  console.log(`$ ${cmd}   (in ${path.relative(root, cwd) || '.'})`);
  execSync(cmd, { cwd, stdio: 'inherit' });
};

run('npm ci --no-audit --no-fund', root);
run('npm run build', root);

const server = path.join(here, 'server');
fs.rmSync(server, { recursive: true, force: true });
fs.mkdirSync(path.join(server, 'dist'), { recursive: true });
fs.cpSync(path.join(root, 'bin'), path.join(server, 'bin'), { recursive: true });
fs.cpSync(path.join(root, 'dist', 'src'), path.join(server, 'dist', 'src'), { recursive: true });
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const rootLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
if (rootLock.lockfileVersion !== 3 || !rootLock.packages?.['']) {
  throw new Error('Expected a lockfileVersion 3 root package-lock.json');
}

// Pin the generated server manifest to the versions that the root build just
// tested, and derive its production-only lock from the same source. This keeps
// VSIX builds reproducible without committing anything below vscode/server/.
const lockedDependencies = Object.fromEntries(
  Object.keys(rootPkg.dependencies ?? {}).sort().map((name) => {
    const locked = rootLock.packages[`node_modules/${name}`];
    if (!locked?.version) throw new Error(`Root lock is missing production dependency ${name}`);
    return [name, locked.version];
  }),
);
const serverPkg = {
  name: 'processj-lsp-server',
  version: rootPkg.version,
  private: true,
  license: rootPkg.license,
  main: 'dist/src/server.js',
  engines: rootPkg.engines,
  dependencies: lockedDependencies,
};
const serverLock = {
  name: serverPkg.name,
  version: serverPkg.version,
  lockfileVersion: rootLock.lockfileVersion,
  requires: true,
  packages: Object.fromEntries([
    ['', {
      name: serverPkg.name,
      version: serverPkg.version,
      license: serverPkg.license,
      dependencies: lockedDependencies,
      engines: serverPkg.engines,
    }],
    ...Object.entries(rootLock.packages)
      .filter(([location, pkg]) => location && pkg.dev !== true)
      .sort(([a], [b]) => a.localeCompare(b)),
  ]),
};
const serverPackagePath = path.join(server, 'package.json');
const serverLockPath = path.join(server, 'package-lock.json');
fs.writeFileSync(serverPackagePath, `${JSON.stringify(serverPkg, null, 2)}\n`);
const expectedServerLock = `${JSON.stringify(serverLock, null, 2)}\n`;
fs.writeFileSync(serverLockPath, expectedServerLock);
run('npm ci --omit=dev --no-audit --no-fund', server);

// npm ci must consume, not rewrite, the generated lock. Also verify every
// locked production package is present at exactly the root-tested version and
// that no root dev-only package leaked into the VSIX server tree.
if (fs.readFileSync(serverLockPath, 'utf8') !== expectedServerLock) {
  throw new Error('npm ci unexpectedly changed the generated server lock');
}
for (const [location, locked] of Object.entries(serverLock.packages)) {
  if (!location) continue;
  const manifest = path.join(server, location, 'package.json');
  if (!fs.existsSync(manifest)) {
    if (locked.optional) continue;
    throw new Error(`npm ci did not install locked production package ${location}`);
  }
  const installed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (installed.version !== locked.version) {
    throw new Error(`Locked ${location}@${locked.version}, installed ${installed.version}`);
  }
}
for (const [location, locked] of Object.entries(rootLock.packages)) {
  if (location && locked.dev === true && fs.existsSync(path.join(server, location))) {
    throw new Error(`Dev-only package leaked into generated server: ${location}`);
  }
}

run(fs.existsSync(path.join(here, 'package-lock.json')) ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund', here);

// esbuild embeds the language client's production dependencies into one file,
// so their license texts would otherwise disappear from the VSIX. Resolve the
// actual installed dependency tree (including nested versions) and emit one
// deterministic notice alongside the bundle.
const dependencyNotices = new Map();
const resolveDependencyManifest = (name, requester) => {
  let directory = requester;
  for (;;) {
    const candidate = path.join(directory, 'node_modules', ...name.split('/'), 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Cannot resolve bundled dependency ${name} from ${requester}`);
    directory = parent;
  }
};
const visitDependency = (name, requester) => {
  // Read the manifest by path instead of require.resolve("pkg/package.json"):
  // several LSP packages intentionally do not export that subpath.
  const manifest = resolveDependencyManifest(name, requester);
  const packageDir = path.dirname(manifest);
  const realDir = fs.realpathSync(packageDir);
  if (dependencyNotices.has(realDir)) return;
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const licenseFile = fs.readdirSync(packageDir)
    .sort()
    .find((entry) => /^(?:licen[cs]e|copying)(?:\.|$)/i.test(entry));
  if (!licenseFile) throw new Error(`No license file found for bundled dependency ${pkg.name}@${pkg.version}`);
  const noticeFiles = fs.readdirSync(packageDir)
    .sort()
    .filter((entry) => /^(?:notice|third[-_ ]?party.*notice)/i.test(entry));
  dependencyNotices.set(realDir, {
    name: pkg.name,
    version: pkg.version,
    license: pkg.license ?? 'see text below',
    text: fs.readFileSync(path.join(packageDir, licenseFile), 'utf8').trim(),
    notices: noticeFiles.map((file) => ({ file, text: fs.readFileSync(path.join(packageDir, file), 'utf8').trim() })),
  });
  for (const child of Object.keys(pkg.dependencies ?? {}).sort()) visitDependency(child, packageDir);
};
for (const dependency of Object.keys(JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).dependencies ?? {}).sort()) {
  visitDependency(dependency, here);
}
const thirdPartyText = [
  'THIRD-PARTY SOFTWARE NOTICES AND INFORMATION',
  '',
  'The following production dependencies are bundled into the ProcessJ VS Code extension.',
  ...[...dependencyNotices.values()]
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
    .flatMap((entry) => [
      '',
      '='.repeat(78),
      `${entry.name}@${entry.version} (${entry.license})`,
      '='.repeat(78),
      entry.text,
      ...entry.notices.flatMap((notice) => ['', `Upstream notice: ${notice.file}`, '-'.repeat(78), notice.text]),
    ]),
  '',
].join('\n');
fs.writeFileSync(path.join(here, 'THIRD_PARTY_NOTICES.txt'), thirdPartyText);

run('npx tsc -p tsconfig.json --noEmit', here);
// Bundle the extension with its client library into one file: the .vsix then needs no node_modules.
run('npx esbuild src/extension.ts --bundle --platform=node --format=cjs --external:vscode --outfile=out/extension.js --sourcemap', here);
console.log('\nBuilt. Next: `npm run package` for a .vsix, or `npm run install-extension` to install it into VS Code.');
