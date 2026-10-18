const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const asar = require('@electron/asar');
const repository = path.resolve(__dirname, '..');
const manifestPath = 'dist/main/workspace-build.json';
const nativePackage = { name: 'crokodial-dialer', main: 'dist/main/main.js', build: { appId: 'com.crokodial.workspace', productName: 'Crokodial Workspace' } };
const fixtureTest = (name, fn) => test(name, { skip: process.platform !== 'darwin' && 'macOS bundle verifier uses plutil' }, fn);

function write(root, name, content) {
  const filename = path.join(root, name);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, typeof content === 'string' ? content : JSON.stringify(content));
}
function createFixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-build-identity-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'native-source');
  const packaged = path.join(temporary, 'packaged-files');
  const bundle = path.join(temporary, 'Crokodial Workspace.app');
  write(source, 'scripts/workspace-build-identity.mjs', fs.readFileSync(path.join(repository, 'scripts/workspace-build-identity.mjs'), 'utf8'));
  fs.symlinkSync(path.join(repository, 'node_modules'), path.join(source, 'node_modules'), 'dir');
  write(source, 'package.json', nativePackage);
  write(source, 'src/main/main.ts', '// TEST main source\n');
  write(source, 'src/preload/preload.ts', '// TEST preload source\n');
  write(source, 'src/renderer/PersonalAssistant.tsx', '// TEST native assistant source\n');
  write(source, 'dist/main/main.js', '// TEST compiled main\n');
  write(source, 'dist/main/preload.js', '// TEST compiled preload\n');
  write(source, 'dist/main/platform-config.json', { origin: 'https://fixture.invalid' });
  write(source, 'dist-renderer/index.html', '<!doctype html><p>TEST native renderer</p>');
  write(source, 'dist-renderer/assets/assistant.js', '// TEST compiled renderer\n');
  const run = (...args) => spawnSync(process.execPath, [path.join(source, 'scripts/workspace-build-identity.mjs'), ...args], { cwd: temporary, encoding: 'utf8' });
  const plist = (bundleIdentifier = nativePackage.build.appId) => write(bundle, 'Contents/Info.plist', `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleIdentifier}</string><key>CFBundleName</key><string>Crokodial Workspace</string><key>CFBundleExecutable</key><string>Crokodial Workspace</string></dict></plist>`);
  const pack = async () => {
    fs.rmSync(packaged, { recursive: true, force: true });
    fs.mkdirSync(packaged, { recursive: true });
    fs.cpSync(path.join(source, 'dist'), path.join(packaged, 'dist'), { recursive: true });
    fs.cpSync(path.join(source, 'dist-renderer'), path.join(packaged, 'dist-renderer'), { recursive: true });
    write(packaged, 'package.json', { name: nativePackage.name, main: nativePackage.main });
    fs.mkdirSync(path.join(bundle, 'Contents/Resources'), { recursive: true });
    await asar.createPackage(packaged, path.join(bundle, 'Contents/Resources/app.asar'));
  };
  plist(); write(bundle, 'Contents/MacOS/Crokodial Workspace', 'TEST executable placeholder; never launched\n');
  return { source, packaged, bundle, run, plist, pack };
}
const succeeds = result => assert.equal(result.status, 0, result.stderr || result.stdout);
const fails = (result, pattern) => { assert.notEqual(result.status, 0); assert.match(result.stderr + result.stdout, pattern); assert.doesNotMatch(result.stdout, /"sourceBuildParity": "verified"/); };

fixtureTest('an exact native source and archive verify independently of the current directory', async t => {
  const f = createFixture(t);
  succeeds(f.run()); await f.pack();
  const result = f.run('--verify-bundle', f.bundle); succeeds(result);
  const identity = JSON.parse(result.stdout);
  assert.equal(identity.application, 'Crokodial Workspace');
  assert.equal(identity.bundleIdentifier, 'com.crokodial.workspace');
  assert.equal(identity.bundle, f.bundle); assert.equal(identity.sourceBuildParity, 'verified');
  for (const key of ['nativeSourceSha256', 'compiledSha256', 'archiveSha256']) assert.match(identity[key], /^[a-f\d]{64}$/);
});

fixtureTest('changed assistant source cannot pass an earlier packaged identity', async t => {
  const f = createFixture(t); succeeds(f.run()); await f.pack();
  write(f.source, 'src/renderer/PersonalAssistant.tsx', '// TEST changed source\n');
  fails(f.run('--verify-bundle', f.bundle), /does not match current native source/);
});

for (const filename of ['dist/main/main.js', 'dist/main/preload.js', 'dist/main/platform-config.json', 'dist-renderer/assets/assistant.js']) fixtureTest(`tampering with ${filename} invalidates the compiled digest`, async t => {
  const f = createFixture(t); succeeds(f.run());
  write(f.source, filename, '// TEST tampered compiled bytes\n'); await f.pack();
  fails(f.run('--verify-bundle', f.bundle), /compiled files do not match/);
});

fixtureTest('recording requires the preload output alongside main and renderer', t => {
  const f = createFixture(t); fs.unlinkSync(path.join(f.source, 'dist/main/preload.js'));
  fails(f.run(), /Build main, preload/);
  assert.equal(fs.existsSync(path.join(f.source, manifestPath)), false);
});

fixtureTest('an absent packaged manifest is rejected', async t => {
  const f = createFixture(t); await f.pack();
  fails(f.run('--verify-bundle', f.bundle), /workspace-build\.json|not found/);
});

fixtureTest('a wrong application cannot reuse the correct archive manifest', async t => {
  const f = createFixture(t); succeeds(f.run()); await f.pack(); f.plist('com.example.wrong-app');
  fails(f.run('--verify-bundle', f.bundle), /Wrong packaged application identity/);
});

fixtureTest('a false app identity inside the manifest is rejected', async t => {
  const f = createFixture(t); succeeds(f.run());
  const identity = JSON.parse(fs.readFileSync(path.join(f.source, manifestPath), 'utf8'));
  write(f.source, manifestPath, { ...identity, application: 'Wrong app' }); await f.pack();
  fails(f.run('--verify-bundle', f.bundle), /Wrong application identity/);
});

fixtureTest('the archive must launch the verified entrypoint', async t => {
  const f = createFixture(t); succeeds(f.run()); await f.pack();
  write(f.packaged, 'package.json', { name: nativePackage.name, main: 'unverified.js' });
  await asar.createPackage(f.packaged, path.join(f.bundle, 'Contents/Resources/app.asar'));
  fails(f.run('--verify-bundle', f.bundle), /Wrong packaged project or entrypoint/);
});

fixtureTest('the explicit bundle argument has no optional bypass or fallback', async t => {
  const f = createFixture(t); succeeds(f.run()); await f.pack();
  fails(f.run('--verify-bundle'), /Provide only the exact/);
  fails(f.run('--verify-bundle', f.bundle, '--skip-checks'), /Provide only the exact/);
  fails(f.run('--verify-bundle', path.join(path.dirname(f.bundle), 'Missing.app')), /Info\.plist|does not exist/);
  fails(f.run('--record-anyway'), /Use no arguments/);
});

fixtureTest('symlinked source cannot be omitted from the source digest', t => {
  const f = createFixture(t);
  fs.symlinkSync(path.join(f.source, 'src/main/main.ts'), path.join(f.source, 'src/main/linked.ts'));
  fails(f.run(), /cannot omit a symbolic link/);
});

fixtureTest('packaging may omit the non-runtime gitkeep placeholder', async t => {
  const f = createFixture(t); write(f.source, 'dist-renderer/.gitkeep', '');
  succeeds(f.run()); fs.unlinkSync(path.join(f.source, 'dist-renderer/.gitkeep')); await f.pack();
  succeeds(f.run('--verify-bundle', f.bundle));
});

fixtureTest('the actual CommonJS PostCSS configuration is included in source identity', async t => {
  const f = createFixture(t); write(f.source, 'postcss.config.cjs', 'module.exports = {};');
  succeeds(f.run()); await f.pack(); write(f.source, 'postcss.config.cjs', 'module.exports = { plugins: [] };');
  fails(f.run('--verify-bundle', f.bundle), /does not match current native source/);
});
