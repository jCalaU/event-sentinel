import { buildServer } from './app.js';
import { createExample } from './env.js';

const { env, pool, sentinel } = createExample();
const app = buildServer({ sentinel });
const worker = env.RUN_WORKER === 'true' ? sentinel.startWorker() : undefined;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
  await worker?.stop();
  await pool.end();
}
process.once('SIGINT', () => {
  void stop();
});
process.once('SIGTERM', () => {
  void stop();
});
try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  console.log(
    `Order webhook ready at http://localhost:${env.PORT}/webhooks/kapso`,
  );
} catch {
  console.error('Example server could not start');
  await stop();
  process.exitCode = 1;
}
