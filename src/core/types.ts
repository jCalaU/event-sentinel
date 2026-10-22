import type { QueryResult, QueryResultRow } from 'pg';
import type { ReceivedPayload } from '../kapso/schema.js';

export type Headers = Record<string, string | string[] | undefined>;
export interface MessageEvent {
  logicalId: string;
  eventType: 'whatsapp.message.received';
  phoneNumberId: string;
  message: ReceivedPayload['message'];
  payload: ReceivedPayload;
}
/** Only use short, parameterized database statements. Do not manage the transaction. */
export interface Transaction {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}
export interface HandlerContext {
  transaction: Transaction;
  signal: AbortSignal;
  eventId: string;
}
export type MessageHandler = (
  event: MessageEvent,
  context: HandlerContext,
) => Promise<void>;
export interface WorkerOptions {
  maxAttempts?: number;
  pollIntervalMs?: number;
  handlerTimeoutMs?: number;
  leaseMs?: number;
  shutdownTimeoutMs?: number;
  retryBaseMs?: number;
}
export interface WorkerController {
  stop(): Promise<void>;
  done: Promise<void>;
}
export interface IngestResult {
  statusCode: number;
  body: { ok: boolean; inserted?: number; duplicates?: number; error?: string };
}
