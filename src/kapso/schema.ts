import { z } from 'zod';

const identity = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0);
export const receivedPayloadSchema = z
  .object({
    message: z
      .object({
        id: identity,
        timestamp: z.string(),
        type: identity,
        text: z.object({ body: z.string() }).passthrough().optional(),
        kapso: z
          .object({ origin: z.string().optional() })
          .passthrough()
          .optional(),
      })
      .passthrough(),
    conversation: z
      .object({ id: identity, phone_number_id: identity.optional() })
      .passthrough(),
    phone_number_id: identity,
  })
  .passthrough();
export type ReceivedPayload = z.infer<typeof receivedPayloadSchema>;
