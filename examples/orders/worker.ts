import { createExample } from './env.js';

const { pool, sentinel } = createExample();
const worker = sentinel.startWorker();
process.once('SIGINT', () => {
  void worker.stop();
});
process.once('SIGTERM', () => {
  void worker.stop();
});
await worker.done;
await pool.end();
