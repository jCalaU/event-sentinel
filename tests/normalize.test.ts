import { describe, expect, it } from 'vitest';
import { normalizePayload } from '../src/kapso/normalize.js';
import {
  batchPayload,
  eventType,
  messagePayload,
  phoneNumberId,
} from './helpers.js';

const headers = { 'x-webhook-event': eventType };

describe('Kapso v2 received-message normalization', () => {
  it('accepts a single message without a personal phone number', () => {
    const [event] = normalizePayload(messagePayload(), headers, phoneNumberId);
    expect(event).toMatchObject({
      eventType,
      phoneNumberId,
      message: { id: 'wamid.synthetic.001' },
    });
    expect(event?.logicalId).toBeTruthy();
  });

  it('keeps unknown fields and origin as data', () => {
    const payload = { ...messagePayload(), future_field: { useful: true } };
    payload.message.kapso.origin = 'history_sync';
    const [event] = normalizePayload(payload, headers, phoneNumberId);
    expect(event?.payload).toEqual(payload);
    expect(event?.message.kapso).toMatchObject({ origin: 'history_sync' });
  });

  it('normalizes every batch item, including a one-item batch', () => {
    for (const ids of [['wamid.one'], ['wamid.one', 'wamid.two']]) {
      const events = normalizePayload(
        batchPayload(ids),
        { ...headers, 'x-webhook-batch': 'true' },
        phoneNumberId,
      );
      expect(events.map((event) => event.message.id)).toEqual(ids);
    }
  });

  it('uses the same logical identity in batches and standalone delivery', () => {
    const [single] = normalizePayload(messagePayload(), headers, phoneNumberId);
    const [batch] = normalizePayload(
      batchPayload(),
      { ...headers, 'x-webhook-batch': 'true' },
      phoneNumberId,
    );
    expect(batch?.logicalId).toBe(single?.logicalId);
  });

  it('scopes identity to the phone number', () => {
    const [first] = normalizePayload(messagePayload(), headers, phoneNumberId);
    const [second] = normalizePayload(
      messagePayload(undefined, 'phone_test_002'),
      headers,
      'phone_test_002',
    );
    expect(second?.logicalId).not.toBe(first?.logicalId);
  });

  it.each([
    {},
    { ...messagePayload(), message: { type: 'text' } },
    { ...messagePayload(), message: { id: '' } },
    { ...messagePayload(), phone_number_id: undefined },
    { ...messagePayload(), conversation: undefined },
    { ...messagePayload(), phone_number_id: 'another_phone' },
    { type: eventType, batch: true, data: [] },
    { ...batchPayload(), data: [messagePayload(), { message: {} }] },
  ])('rejects missing identity or invalid structure', (payload) => {
    expect(() => normalizePayload(payload, headers, phoneNumberId)).toThrow();
  });

  it('rejects unsupported events', () => {
    expect(() =>
      normalizePayload(
        messagePayload(),
        { 'x-webhook-event': 'whatsapp.message.sent' },
        phoneNumberId,
      ),
    ).toThrow();
  });

  it('rejects a batch header on a single payload', () => {
    expect(() =>
      normalizePayload(
        messagePayload(),
        { ...headers, 'x-webhook-batch': 'true' },
        phoneNumberId,
      ),
    ).toThrow();
  });

  it('rejects conflicting batch metadata', () => {
    expect(() =>
      normalizePayload(
        batchPayload(),
        { ...headers, 'x-webhook-batch': 'false' },
        phoneNumberId,
      ),
    ).toThrow();
  });

  it('rejects a conversation scoped to another phone number', () => {
    const payload = messagePayload();
    payload.conversation.phone_number_id = 'another_phone';
    expect(() => normalizePayload(payload, headers, phoneNumberId)).toThrow();
  });
});
