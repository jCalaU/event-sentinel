import { fork, type ChildProcess } from 'node:child_process';

export function startWorkerProcess(
  mode: 'normal' | 'hang' | 'block' = 'normal',
) {
  const child = fork(
    new URL('./fixtures/worker-process.ts', import.meta.url),
    [],
    {
      execArgv: ['--import', 'tsx'],
      env: { ...process.env, TEST_WORKER_MODE: mode },
      silent: true,
    },
  );
  let errors = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const messages: unknown[] = [];
  child.on('message', (message: unknown) => {
    messages.push(message);
  });
  return {
    child,
    hasMessage(type: string) {
      return messages.some(
        (value) =>
          typeof value === 'object' &&
          value !== null &&
          'type' in value &&
          value.type === type,
      );
    },
    async waitFor(type: string) {
      const until = Date.now() + 5_000;
      while (Date.now() < until) {
        if (
          messages.some(
            (value) =>
              typeof value === 'object' &&
              value !== null &&
              'type' in value &&
              value.type === type,
          )
        )
          return;
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`Worker exited before ${type}: ${errors}`);
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      throw new Error(`Worker did not report ${type}: ${errors}`);
    },
  };
}

export async function stopWorkerProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  if (child.connected) child.send('stop');
  const force = setTimeout(() => child.kill('SIGKILL'), 2_000);
  await exited;
  clearTimeout(force);
}

export async function killWorkerProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  child.kill('SIGKILL');
  await exited;
}
