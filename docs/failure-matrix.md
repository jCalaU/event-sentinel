# Failure matrix

Tests use signed synthetic requests. Transaction and worker tests use a real PostgreSQL database. `npm test` runs unit tests. `npm run test:integration` requires the test database and fails if it cannot connect.

| Case                                               | Result                                                   |
| -------------------------------------------------- | -------------------------------------------------------- |
| Signature is absent, malformed or wrong            | 401; no event or handler                                 |
| JSON is invalid                                    | 400; no event or handler                                 |
| Phone-number ID is wrong                           | 400; no event or handler                                 |
| Message identity is absent                         | 400; no event or handler                                 |
| Unsupported event or explicit payload version      | 400; no handler                                          |
| Body is over the size limit                        | 413; no event or handler                                 |
| Content type is not JSON                           | 415; no event or handler                                 |
| One batch item is invalid                          | 400 for the whole delivery; no new item is stored        |
| One insert in a batch fails                        | The whole transaction rolls back; 503                    |
| Single event arrives ten times                     | One logical event and one committed order                |
| Batch arrives again                                | One logical event per distinct message                   |
| Batch items arrive later as singles                | Existing items are duplicates                            |
| Same message ID belongs to a different number      | Separate logical events                                  |
| Database is down during receive                    | 503; Kapso can retry                                     |
| Commit result is uncertain after a lost connection | Non-200; a later retry is safe                           |
| Two workers claim due work                         | Each event has one current owner                         |
| Handler writes an order, then throws               | Order rolls back; work is retried                        |
| Worker stops after receive committed               | Stored pending work remains                              |
| Process dies after claim                           | Another worker can recover after the lease ends          |
| An old worker runs past its lease                  | Its local transaction cannot complete the event          |
| Handler fails on every attempt                     | Retry limit ends in `dead`                               |
| Error text contains private data                   | Only a fixed safe error category is stored or logged     |
| Customer has no personal phone number              | Valid when message and configured number IDs exist       |
| Shutdown begins                                    | No new claim; current work may finish within the timeout |

## Invariants

- PostgreSQL's unique constraint allows one row for each `(phone_number_id, event_type, message_id)`.
- HTTP 200 means every accepted item is stored. It does not mean the handler has run.
- An event is marked completed in the same transaction as its local business writes.
- A failed handler cannot leave a partial committed order through `ctx.transaction`.
- Delivery retries after completion cannot create a second order while the identity row is kept.

## What the tests cannot prove

A local fixture test does not prove a real Kapso account is configured correctly. Test that account's HTTPS delivery separately. A database test also cannot make an external API call atomic. See [guarantees and limits](guarantees.md).
