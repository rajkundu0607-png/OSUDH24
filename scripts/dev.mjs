import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(new URL('../.env', import.meta.url))) process.loadEnvFile(new URL('../.env', import.meta.url));
const children = [];
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  const forceExit = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
    process.exit(code);
  }, 3000);
  Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise(resolve => child.once('exit', resolve))))
    .then(() => { clearTimeout(forceExit); process.exit(code); });
}

for (const script of ['server/index.mjs', 'node_modules/vite/bin/vite.js']) {
  const child = spawn(process.execPath, [script], { cwd: root, stdio: 'inherit', env: process.env });
  children.push(child);
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code ?? 1); });
}

process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
