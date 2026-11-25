import { createApp } from './app.mjs';
import { existsSync } from 'node:fs';
import { deploymentOptions } from './deployment.mjs';

if (existsSync('.env')) process.loadEnvFile('.env');

const port = Number(process.env.PORT || process.env.API_PORT || 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('API_PORT must be a number between 1 and 65535.');
  process.exit(1);
}

try {
  const app = createApp({ databasePath: process.env.DATABASE_PATH || 'data/osudh24.sqlite', ...deploymentOptions(process.env) });
  let stopping = false;
  async function shutdown(code) {
    if (stopping) return;
    stopping = true;
    await app.close();
    process.exit(code);
  }
  app.server.on('error', async error => {
    console.error(error.code === 'EADDRINUSE'
      ? `API port ${port} is already in use. Stop the other server or set API_PORT.`
      : `Could not start the API server: ${error.code || error.message}`);
    await shutdown(1);
  });
  app.server.listen(port, '127.0.0.1', () => console.log(`Osudh24 API ready at http://127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    await shutdown(0);
  });
} catch (error) {
  console.error(`Could not open the local database: ${error.code || error.message}`);
  process.exit(1);
}
