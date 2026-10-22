import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySignature } from '../src/kapso/signature.js';

const secret = 'synthetic-test-secret';
const body = Buffer.from('{ "message": "synthetic café" }\n');
const signature = createHmac('sha256', secret).update(body).digest('hex');

describe('Kapso raw body signature', () => {
  it('accepts the HMAC-SHA256 hex signature of the exact bytes', () => {
    expect(verifySignature(body, signature, secret)).toBe(true);
  });

  it('accepts uppercase hexadecimal signatures', () => {
    expect(verifySignature(body, signature.toUpperCase(), secret)).toBe(true);
  });

  it('rejects valid JSON with different whitespace', () => {
    expect(
      verifySignature(
        Buffer.from(JSON.stringify(JSON.parse(body.toString()))),
        signature,
        secret,
      ),
    ).toBe(false);
  });

  it('rejects a changed byte or the wrong secret', () => {
    expect(
      verifySignature(
        Buffer.concat([body, Buffer.from(' ')]),
        signature,
        secret,
      ),
    ).toBe(false);
    expect(verifySignature(body, signature, 'another-secret')).toBe(false);
  });

  it.each([
    undefined,
    '',
    '0'.repeat(63),
    '0'.repeat(65),
    'z'.repeat(64),
    `sha256=${signature}`,
  ])('rejects malformed signature %s without throwing', (value) => {
    expect(verifySignature(body, value, secret)).toBe(false);
  });
});
