import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySignature(
  rawBody: Buffer,
  signature: unknown,
  secret: string,
): boolean {
  if (typeof signature !== 'string' || !/^[a-fA-F0-9]{64}$/.test(signature))
    return false;
  const actual = Buffer.from(signature, 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
