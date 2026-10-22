import type { Logger } from 'pino';
import type { PostgresStore } from '../db/postgres.js';
import { header, normalizePayload } from '../kapso/normalize.js';
import { verifySignature } from '../kapso/signature.js';
import type { Headers, IngestResult } from './types.js';

export function createIngestion(options: {
  webhookSecret: string;
  phoneNumberId: string;
  maxBodyBytes: number;
  store: PostgresStore;
  logger: Logger;
}) {
  return async ({
    rawBody,
    headers,
  }: {
    rawBody: Buffer;
    headers: Headers;
  }): Promise<IngestResult> => {
    const fail = (statusCode: number, error: string): IngestResult => ({
      statusCode,
      body: { ok: false, error },
    });
    if (!Buffer.isBuffer(rawBody))
      return fail(400, 'Raw body must be a Buffer');
    if (rawBody.length > options.maxBodyBytes)
      return fail(413, 'Request body too large');
    if (
      header(headers, 'content-type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json'
    )
      return fail(415, 'Content-Type must be application/json');
    if (
      !verifySignature(
        rawBody,
        header(headers, 'x-webhook-signature'),
        options.webhookSecret,
      )
    ) {
      options.logger.warn(
        { outcome: 'rejected_signature', count: 1 },
        'Webhook rejected',
      );
      return fail(401, 'Invalid signature');
    }
    let events;
    try {
      // Fatal decoding rejects invalid UTF-8 rather than changing signed bytes silently.
      const input: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(rawBody),
      );
      events = normalizePayload(input, headers, options.phoneNumberId);
    } catch {
      return fail(400, 'Invalid or unsupported received-message payload');
    }
    try {
      const result = await options.store.persist(
        events,
        header(headers, 'x-idempotency-key'),
      );
      options.logger.info(
        {
          outcome: 'received',
          ingested: result.inserted,
          duplicates: result.duplicates,
        },
        'Webhook stored',
      );
      return { statusCode: 200, body: { ok: true, ...result } };
    } catch {
      options.logger.error(
        { outcome: 'store_failed' },
        'Webhook database unavailable',
      );
      return fail(503, 'Database unavailable; retry delivery');
    }
  };
}
