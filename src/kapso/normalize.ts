import { z } from 'zod';
import type { Headers, MessageEvent } from '../core/types.js';
import { receivedPayloadSchema } from './schema.js';

export const EVENT_TYPE = 'whatsapp.message.received' as const;
export function header(headers: Headers, name: string): string | undefined {
  const entries = Object.entries(headers).filter(
    ([key]) => key.toLowerCase() === name,
  );
  if (entries.length !== 1 || typeof entries[0]?.[1] !== 'string')
    return undefined;
  return entries[0][1];
}

export function normalizePayload(
  input: unknown,
  headers: Headers,
  phoneNumberId: string,
): MessageEvent[] {
  if (header(headers, 'x-webhook-event') !== EVENT_TYPE)
    throw new Error('Unsupported event type');
  const version = header(headers, 'x-webhook-payload-version');
  if (version !== undefined && version !== 'v2')
    throw new Error('Unsupported payload version');
  const object = z
    .object({ batch: z.boolean().optional(), type: z.string().optional() })
    .passthrough()
    .parse(input);
  const batchHeader = header(headers, 'x-webhook-batch');
  if (
    batchHeader !== undefined &&
    batchHeader !== 'true' &&
    batchHeader !== 'false'
  )
    throw new Error('Invalid batch header');
  if (batchHeader === 'false' && object.batch === true)
    throw new Error('Conflicting batch header');
  if (object.type !== undefined && object.type !== EVENT_TYPE)
    throw new Error('Unsupported event type');
  const batched = object.batch === true || batchHeader === 'true';
  const items = batched
    ? z
        .object({
          type: z.literal(EVENT_TYPE),
          batch: z.literal(true),
          data: z.array(receivedPayloadSchema).min(1),
        })
        .passthrough()
        .parse(input).data
    : [receivedPayloadSchema.parse(input)];
  return items.map((payload) => {
    if (
      payload.phone_number_id !== phoneNumberId ||
      (payload.conversation.phone_number_id !== undefined &&
        payload.conversation.phone_number_id !== phoneNumberId)
    )
      throw new Error('Wrong phone number ID');
    return {
      logicalId: JSON.stringify([
        phoneNumberId,
        EVENT_TYPE,
        payload.message.id,
      ]),
      eventType: EVENT_TYPE,
      phoneNumberId,
      message: payload.message,
      payload,
    };
  });
}
