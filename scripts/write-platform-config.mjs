import { loadEnv } from 'vite';
import fs from 'node:fs';
const environment = loadEnv(process.env.CROKODIAL_BUILD_MODE || 'production', process.cwd());
const raw = process.env.VITE_API_BASE ?? environment.VITE_API_BASE;
if (!raw) throw new Error('Set VITE_API_BASE before building Crokodial Workspace.');
const url = new URL(raw);
if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('Platform URL must use HTTPS or loopback HTTP.');
fs.mkdirSync('dist/main', { recursive: true });
fs.writeFileSync('dist/main/platform-config.json', JSON.stringify({ origin: url.origin }));
