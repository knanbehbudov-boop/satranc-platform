import { createApp } from './app.ts';
import { loadConfig } from './config.ts';

const cfg = loadConfig();
const app = await createApp(cfg);
await app.start();

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.logger.info('Kapanıyor', { signal });
  await app.stop();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
