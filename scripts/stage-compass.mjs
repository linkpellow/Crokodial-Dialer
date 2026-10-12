// Package the existing runtime/data without credentials, caches, models or voice training corpora.
import fs from 'node:fs';
import path from 'node:path';
const source = process.env.CROKODIAL_COMPASS_SOURCE;
if (!source || !fs.existsSync(path.join(source, 'src/assistant/orchestrator.js'))) throw new Error('Set CROKODIAL_COMPASS_SOURCE to the existing Quotes Compass repository.');
const target = path.resolve('resources/quotes-compass');
if (target === path.resolve(source)) throw new Error('The staging directory must differ from the source.');
const excluded = new Set(['backgrounds', 'rirs', 'piper', 'features', 'wake']);
const filter = filename => {
  const base = path.basename(filename);
  if (base.startsWith('._') || base === '.DS_Store' || base.startsWith('.env')) return false;
  const parts = path.relative(source, filename).split(path.sep);
  return !(parts[0] === 'data' && excluded.has(parts[1]));
};
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
for (const folder of ['src', 'data']) fs.cpSync(path.join(source, folder), path.join(target, folder), { recursive: true, filter });
fs.mkdirSync(path.join(target, 'apps/plan-assistant'), { recursive: true });
fs.copyFileSync(path.join(source, 'apps/plan-assistant/greeting-template.cjs'), path.join(target, 'apps/plan-assistant/greeting-template.cjs'));
fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
console.log('Staged Quotes Compass source and insurance data. Credentials, caches and voice training corpora excluded.');
