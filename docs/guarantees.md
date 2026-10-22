# Guarantees and limits

## Accepted means stored

`ingest()` does not run the business handler. It verifies the original request bytes, validates all items, then commits them in one PostgreSQL transaction. Each new event row is also its pending job.

HTTP 200 means every accepted message is durably stored, or was already stored. It does not mean business work is complete. If the database fails, the response is 503. A lost connection around commit can make its result unclear. Returning a failure is safe: the next delivery uses the same message identity and cannot add a second row.

The pool must use `connectionTimeoutMillis` from 1 to 3,000 ms. The receive transaction has a 6-second timer, with 3-second statement and 2-second lock limits. On timeout, the database connection is closed and receive returns 503. This leaves time for Kapso's 10-second response deadline while Node's event loop is running normally. It is not a real-time deadline during a paused or overloaded process.

Pool pipeline mode is rejected. Safe cancellation requires closing the connection to roll back its transaction.

PostgreSQL must use durable storage and normal durable commit settings. EventSentinel cannot protect against loss of the database itself. Keep backups and test recovery.

## One committed local result

Work has **at-least-once** execution. A handler can start more than once. For short database work through `ctx.transaction`, the business writes and the `completed` state share one transaction. Both commit, or both roll back.

The identity `(phone_number_id, event_type, message_id)` has a unique constraint. A repeated delivery never creates another job for that identity while its row is kept. The order example also has a unique message ID.

This guarantee requires all related business writes to use the supplied transaction in the same PostgreSQL database. Do not open another connection for those writes. Do not issue transaction commands, keep the query object after the handler, modify EventSentinel tables, or use database functions with effects outside PostgreSQL's transaction. The handler is trusted application code.

Idempotency means **processing the same message again does not create another result**. A message ID is not always the right business ID. If two different messages ask for the same booking, the application must also protect that booking with its own business key.

## Lease ownership and recovery

Each claim gets a new random lease token and a database deadline. Claims use `FOR UPDATE SKIP LOCKED`, so workers do not wait on work another transaction owns. A crash leaves a row that another worker can reclaim after its lease ends. Claims count as attempts, including a claim followed by a process crash.

Before the handler starts, the worker locks the event row and checks the token and database time. It keeps that row lock during the short business transaction. Before marking the event completed, it checks the token and deadline again. If that check fails, it rolls back the business writes. The lock prevents a replacement owner from committing conflicting local work during this check and commit.

A lease does not stop JavaScript. A slow callback may keep running after a timeout. The worker closes its database connection to roll back work, aborts `ctx.signal`, and blocks later queries through the transaction wrapper. The callback must observe cancellation and must not start untracked work. PostgreSQL's `statement_timeout` and `idle_in_transaction_session_timeout` both use the handler timeout, so PostgreSQL can release the row lock even when JavaScript's event loop stalls.

Lease checks protect database effects. They do not stop remote calls or arbitrary code that ignores cancellation. This library does not provide strict conversation ordering.

## Retries, dead work and shutdown

Handler errors roll back local work. The worker schedules bounded exponential backoff with jitter. After the configured total attempt limit, the event is `dead`. A `dead` event is retained for investigation. It is not automatically deleted or replayed. Error records contain safe categories, not the thrown message or payload.

Defaults are five total attempts, a 250 ms poll interval, a 5-second handler timeout, a 15-second lease and a 10-second shutdown limit. Retry delay starts between 500 and 1,000 ms, doubles after each failure, and is capped at 60 seconds before jitter. Keep the handler timeout shorter than the lease. Configure worker settings through the `worker` option of `createEventSentinel()`.

`startWorker()` returns a controller immediately. `await controller.stop()` stops new claims and waits for current work. `controller.done` resolves when the loop ends. An optional `AbortSignal` also requests shutdown. If current work exceeds the shutdown limit, its database connection is closed. Stop workers before closing the pool. A claim already in flight when shutdown starts can remain leased; it is recoverable after expiry.

The shutdown limit also covers pool acquisition, claim queries, queue-age checks and retry writes. Waiting for a connection cannot start another handler after stop is requested. Forced cancellation leaves leased work for recovery instead of waiting for another database write.

## External API calls

Do not call email, CRM, payment or messaging APIs inside the open business transaction. The transaction path is for short local SQL only.

For external work, store a domain outbox item in the same transaction, then let application code send it outside the transaction. Reuse a stable operation ID if the remote API supports idempotency. A domain operation ID can combine the logical event ID with an action name. EventSentinel does not run an external-effect system.

Without remote idempotency, a crash after a successful remote call can leave an unknown result. Investigate the provider's records or reconcile it manually. Retrying can repeat the effect. There is no universal exactly-once guarantee.

## Privacy, retention and logs

Payloads can contain private message text and personal IDs. Normal library logs use internal event UUIDs, counts and safe outcome names. Configure application logs with the same care. Protect the database and backups. Serve real webhooks over HTTPS and keep the webhook secret in the environment.

Choose a retention period for your app. Keep identity rows for at least the full delivery retry and manual replay window. Deleting them removes EventSentinel's duplicate protection for those messages. Back up or inspect dead events before deleting them.

An operator can review old rows with:

```sql
SELECT state, count(*)
FROM webhook_events
WHERE state IN ('completed', 'dead')
  AND updated_at < now() - interval '90 days'
GROUP BY state;
```

Only after the retention period and review, delete old finished rows:

```sql
DELETE FROM webhook_events
WHERE state IN ('completed', 'dead')
  AND updated_at < now() - interval '90 days';
```

This is manual SQL, not an automatic cleanup feature. Adjust 90 days to your policy. Keep any domain uniqueness keys for as long as the business needs them.

## Monitor the queue

Structured log outcomes show receive, duplicate, rejected signature, process, completed, retry and dead results. Aggregate their count fields in your log tool. The worker also reports the oldest unfinished event age.

```sql
SELECT state, count(*) FROM webhook_events GROUP BY state;

SELECT EXTRACT(EPOCH FROM (now() - min(created_at))) AS oldest_pending_seconds
FROM webhook_events
WHERE state IN ('pending', 'processing');

SELECT id, attempts, last_error, updated_at
FROM webhook_events
WHERE state = 'dead'
ORDER BY updated_at DESC;
```

An increasing pending age, dead rows or repeated database errors needs attention. EventSentinel does not add a monitoring dashboard.

The local benchmark reports the minimum and maximum request sizes, machine details, batch size and database host and port. Its `workerCountSource` says that the worker setting comes from the environment; it does not measure running processes. Record the actual worker count and whether PostgreSQL is local or remote when sharing results.
