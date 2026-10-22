import { pino, type Logger } from 'pino';
import { z } from 'zod';
import { createIngestion } from './core/ingestion.js';
import { startWorker } from './core/worker.js';
import type {
  MessageHandler,
  WorkerOptions,
  WorkerController,
} from './core/types.js';
import type { PostgresStore } from './db/postgres.js';

export { createPostgresStore } from './db/postgres.js';
export type { PostgresStore } from './db/postgres.js';
export type {
  MessageEvent,
  MessageHandler,
  HandlerContext,
  Transaction,
  Headers,
  IngestResult,
  WorkerOptions,
  WorkerController,
} from './core/types.js';
export type { ReceivedPayload } from './kapso/schema.js';

const workerSchema = z
  .object({
    maxAttempts: z.number().int().positive().default(5),
    pollIntervalMs: z.number().int().positive().max(2147483647).default(250),
    handlerTimeoutMs: z.number().int().positive().max(2147483647).default(5000),
    leaseMs: z.number().int().positive().max(2147483647).default(15000),
    shutdownTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(2147483647)
      .default(10000),
    retryBaseMs: z.number().int().positive().default(1000),
  })
  .refine(
    (value) => value.leaseMs > value.handlerTimeoutMs,
    'leaseMs must exceed handlerTimeoutMs',
  );

export interface SentinelOptions {
  webhookSecret: string;
  phoneNumberId: string;
  store: PostgresStore;
  onMessage: MessageHandler;
  maxBodyBytes?: number;
  worker?: WorkerOptions;
  logger?: Logger;
}
export function createEventSentinel(options: SentinelOptions) {
  z.string().min(1).parse(options.webhookSecret);
  z.string()
    .min(1)
    .refine((value) => value.trim() === value)
    .parse(options.phoneNumberId);
  const maxBodyBytes = z
    .number()
    .int()
    .positive()
    .parse(options.maxBodyBytes ?? 1024 * 1024);
  const logger =
    options.logger ??
    pino({
      redact: [
        'headers',
        'payload',
        'message',
        'phoneNumberId',
        'secret',
        'credentials',
      ],
    });
  const worker = {
    ...workerSchema.parse(options.worker ?? {}),
    phoneNumberId: options.phoneNumberId,
  };
  let controller: WorkerController | undefined;
  return {
    ingest: createIngestion({ ...options, maxBodyBytes, logger }),
    startWorker(input: { signal?: AbortSignal } = {}): WorkerController {
      if (controller) throw new Error('This sentinel already started a worker');
      controller = startWorker(
        options.store,
        options.onMessage,
        worker,
        logger,
        input,
      );
      return controller;
    },
  };
}
export type EventSentinel = ReturnType<typeof createEventSentinel>;
