import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function filesIn(directory) {
  if (!existsSync(directory)) return [];
  if (lstatSync(directory).isSymbolicLink()) throw new Error(`Build identity cannot follow a symbolic link: ${relative(root, directory)}`);
  return readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    const path = resolve(directory, item.name);
    if (item.isSymbolicLink()) throw new Error(`Build identity cannot omit a symbolic link: ${relative(root, path)}`);
    return item.isDirectory() ? filesIn(path) : item.isFile() && !item.name.startsWith('.env') ? [path] : [];
  });
}
function digestEntries(entries) {
  return hash(entries.sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => `${path}\0${hash(bytes)}\n`).join(''));
}
function sourceDigest() {
  const paths = ['src', 'scripts', 'public'].flatMap(name => filesIn(resolve(root, name))).concat(
    ['package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'tsconfig.main.json', 'tsconfig.preload.json', 'tsconfig.renderer.json', 'vite.config.ts', 'postcss.config.js', 'postcss.config.cjs', 'postcss.config.mjs', 'tailwind.config.js', 'tailwind.config.cjs', 'tailwind.config.ts'].map(name => resolve(root, name)).filter(existsSync));
  return digestEntries(paths.map(path => [relative(root, path), readFileSync(path)]));
}
const manifestPath = 'dist/main/workspace-build.json';
const requiredCompiled = ['dist/main/main.js', 'dist/main/preload.js', 'dist/main/platform-config.json', 'dist-renderer/index.html'];
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
if (pkg.name !== 'crokodial-dialer' || pkg.main !== 'dist/main/main.js' || pkg.build?.appId !== 'com.crokodial.workspace' || pkg.build?.productName !== 'Crokodial Workspace') throw new Error('Wrong native project.');
if (process.argv[2] === '--verify-bundle') {
  if (process.argv.length !== 4) throw new Error('Provide only the exact Crokodial Workspace.app path.');
  const require = createRequire(import.meta.url), asar = require('@electron/asar');
  const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', resolve(process.argv[3], 'Contents/Info.plist')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const executable = resolve(process.argv[3], 'Contents/MacOS/Crokodial Workspace');
  if (info.CFBundleIdentifier !== pkg.build.appId || info.CFBundleName !== pkg.build.productName || info.CFBundleExecutable !== pkg.build.productName || !existsSync(executable) || !lstatSync(executable).isFile()) throw new Error('Wrong packaged application identity.');
  const archive = resolve(process.argv[3], 'Contents/Resources/app.asar');
  const identity = JSON.parse(asar.extractFile(archive, manifestPath));
  if (identity.schemaVersion !== 1 || identity.application !== pkg.build.productName || identity.bundleIdentifier !== pkg.build.appId) throw new Error('Wrong application identity.');
  const packaged = JSON.parse(asar.extractFile(archive, 'package.json'));
  if (packaged.name !== pkg.name || packaged.main !== pkg.main) throw new Error('Wrong packaged project or entrypoint.');
  for (const name of requiredCompiled) {
    const entry = asar.statFile(archive, name, false);
    if (!entry || entry.files || entry.link) throw new Error(`Missing compiled application file: ${name}`);
  }
  const names = asar.listPackage(archive).map(name => name.replace(/^\//, '')).filter(name => /^dist(?:-renderer|\/main)\//.test(name) && name !== manifestPath && basename(name) !== '.gitkeep' && !asar.statFile(archive, name).files);
  if (names.some(name => asar.statFile(archive, name, false).link)) throw new Error('Packaged compiled files must not be symbolic links.');
  const compiled = digestEntries(names.map(name => [name, asar.extractFile(archive, name)]));
  if (identity.nativeSourceSha256 !== sourceDigest()) throw new Error('Packaged application does not match current native source.');
  if (identity.compiledSha256 !== compiled) throw new Error('Packaged compiled files do not match their build identity.');
  console.log(JSON.stringify({ ...identity, bundle: resolve(process.argv[3]), archiveSha256: hash(readFileSync(archive)), sourceBuildParity: 'verified' }, null, 2));
} else {
  if (process.argv.length > 2) throw new Error('Use no arguments to record a build, or --verify-bundle <app>.');
  let sourceRevision = null;
  try { sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Isolated staging can have no Git checkout. Source content remains hashed. */ }
  const compiled = ['dist/main', 'dist-renderer'].flatMap(name => filesIn(resolve(root, name))).filter(path => relative(root, path) !== manifestPath && basename(path) !== '.gitkeep');
  if (requiredCompiled.some(name => !existsSync(resolve(root, name)) || !lstatSync(resolve(root, name)).isFile())) throw new Error('Build main, preload, platform configuration and renderer before recording identity.');
  const identity = { schemaVersion: 1, application: 'Crokodial Workspace', bundleIdentifier: pkg.build.appId, sourceRevision, nativeSourceSha256: sourceDigest(), compiledSha256: digestEntries(compiled.map(path => [relative(root, path), readFileSync(path)])), builtAt: new Date().toISOString() };
  writeFileSync(resolve(root, manifestPath), `${JSON.stringify(identity, null, 2)}\n`);
  console.log(`Recorded Crokodial Workspace build ${identity.nativeSourceSha256.slice(0, 12)}`);
}
