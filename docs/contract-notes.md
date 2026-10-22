# Kapso contract notes

Checked on 21 October 2026. This receiver supports **Kapso phone-number webhooks, event-based payload v2**, for `whatsapp.message.received` only. These notes distinguish the upstream contract from EventSentinel's own safety rules.

## Sources checked

| Source                                                                                                             | What was checked                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| [Webhook security](https://docs.kapso.ai/docs/platform/webhooks/security)                                          | Raw-body HMAC, safe comparison and response deadline                                                                       |
| [Message events](https://docs.kapso.ai/docs/platform/webhooks/message-events)                                      | Current v2 received-message example and optional contact fields                                                            |
| [Delivery](https://docs.kapso.ai/docs/platform/webhooks/advanced)                                                  | Batch envelope, fallback to singles, ordering and retries                                                                  |
| [TypeScript SDK](https://github.com/gokapso/whatsapp-cloud-api-js)                                                 | Current README and [signature source](https://github.com/gokapso/whatsapp-cloud-api-js/blob/master/src/webhooks/verify.ts) |
| [Chat SDK adapter](https://github.com/gokapso/chat-sdk-adapter)                                                    | Current README and [adapter source](https://github.com/gokapso/chat-sdk-adapter/blob/main/src/adapter.ts)                  |
| [Integration guidance](https://github.com/gokapso/agent-plugins/tree/main/plugins/kapso/skills/integrate-whatsapp) | Skill, webhook overview and reference                                                                                      |
| [Webhook overview](https://docs.kapso.ai/docs/platform/webhooks/overview)                                          | Exact header values and phone-number registration route                                                                    |

## Signature and headers

Kapso signs the exact request body bytes with HMAC-SHA256 and the webhook's secret. `X-Webhook-Signature` is a 64-character hex digest with no `sha256=` prefix. Check the format, decode it, compare equal-length buffers with `crypto.timingSafeEqual`, then parse JSON. Reserializing parsed JSON can change the signed bytes. Missing or invalid signatures must fail closed. [Security](https://docs.kapso.ai/docs/platform/webhooks/security)

The SDK separates Kapso verification from Meta verification. Its Kapso helper accepts upper- or lowercase hex; Meta's `verifySignature` expects `sha256=`. EventSentinel uses the Kapso format. The SDK also documents business-scoped user IDs, which can exist without a personal phone number. [SDK signature source](https://github.com/gokapso/whatsapp-cloud-api-js/blob/master/src/webhooks/verify.ts), [SDK README](https://github.com/gokapso/whatsapp-cloud-api-js#business-scoped-user-ids-bsuids)

The documented headers are:

| Header                                       | Meaning                                        |
| -------------------------------------------- | ---------------------------------------------- |
| `Content-Type: application/json`             | JSON body; a charset parameter is accepted     |
| `X-Webhook-Event: whatsapp.message.received` | Event name                                     |
| `X-Webhook-Signature`                        | Raw-body HMAC in hex                           |
| `X-Idempotency-Key`                          | Opaque delivery identifier; not the message ID |
| `X-Webhook-Payload-Version: v2`              | Payload version                                |
| `X-Webhook-Batch: true`                      | Present for a buffered delivery                |
| `X-Batch-Size`                               | Diagnostic item count; not a message identity  |

Register a phone-number webhook through `/platform/v1/whatsapp/phone_numbers/{phone_number_id}/webhooks`, with `kind: "kapso"`, the HTTPS destination and the received-message subscription. The API accepts `secret_key`; keep that exact value in the receiver. Project webhooks serve a different scope. [Overview](https://docs.kapso.ai/docs/platform/webhooks/overview)

## Payload and identity

An unbuffered received-message body has `message`, `conversation` and root `phone_number_id`. The official example has `message.id`, an epoch-string `timestamp`, `type`, and `conversation.id`. Kapso says not to require `phone_number`, `from`, `to` or `wa_id`. Optional origin is under `message.kapso.origin`. Unknown fields can be added. Preserve them as data. The event name comes from `X-Webhook-Event`, not an assumed root `event` property. [Message events](https://docs.kapso.ai/docs/platform/webhooks/message-events)

The application identity is `(phone_number_id, event_type, message.id)`. This is EventSentinel's choice. A delivery key alone cannot cover batch-to-single fallback. A missing identity is rejected; no random fallback identity is made. The configured phone-number ID must match each item. Origin filtering belongs in application code.

## Batches and delivery

A buffered envelope has `type`, `batch: true`, `data: [...]` and `batch_info`. Each data item has the single-message shape. Buffering uses this shape even for one item. Check the body marker and `X-Webhook-Batch`; do not infer a batch from array length. After failed batch retries, Kapso can deliver items as singles. Current delivery docs say the default is three total delivery attempts: initial, then 10 and 40 seconds. The receiver should return 200 within 10 seconds. Ordering has a 30-second timeout, so strict order is not promised. Kapso also monitors failures and can pause an endpoint. [Delivery](https://docs.kapso.ai/docs/platform/webhooks/advanced)

EventSentinel validates the whole batch before writing. One database transaction stores every new item as pending work. A 200 is sent only after commit. These are local safety rules, beyond the short upstream tutorial examples. HTTP failures allow upstream delivery retries; worker retries apply only to stored work.

The existing Chat SDK adapter confirms raw `Request` forwarding, signature checking, received-message subscription and `data` batches. Its sending, reply and conversation features are outside this library's scope. [Adapter README](https://github.com/gokapso/chat-sdk-adapter#webhook-route), [Adapter source](https://github.com/gokapso/chat-sdk-adapter/blob/main/src/adapter.ts)

## Decisions and limits of this review

- The integration skill recommends phone-number scope, `kind: kapso`, payload v2 and signature checks. It documents a test-delivery script. Its older webhook overview lists retries at 10, 40 and 90 seconds. The current live delivery page says three total attempts. Trust the live delivery page; do not implement either upstream retry schedule here. [Integration skill](https://github.com/gokapso/agent-plugins/blob/main/plugins/kapso/skills/integrate-whatsapp/SKILL.md), [Older overview](https://github.com/gokapso/agent-plugins/blob/main/plugins/kapso/skills/integrate-whatsapp/references/webhooks-overview.md)
- Official examples describe payload shape, not a complete required-field schema. EventSentinel checks the fields it uses and preserves the rest. It does not require a human phone number, fixed origin, contact name, media fields or an `is_new_conversation` flag.
- The documented version header is accepted as `v2`; another explicit version is rejected. Its absence is allowed when the body passes v2 validation. Delivery keys and batch counts are diagnostic, not trusted identity.
- Synthetic fixtures are derived from the documented shapes. They are not captured production traffic. No real Kapso account was used for this review. A real account's delivery test remains an operator check; local tests sign the actual fixture bytes.
- No unresolved signature, header or envelope behavior is invented. Payload additions outside the supported event stay unknown data. Unsupported event types receive 400 and never run a handler.
