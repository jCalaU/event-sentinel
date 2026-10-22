# Local verification

Checked with Node.js 24.15.0, and local PostgreSQL 18.4. PostgreSQL ran from a temporary binary package, with data under `/private/tmp`. That package is not a project dependency.

Docker is not installed in this environment. `docker compose up -d` returned `command not found`. The Compose startup path and PostgreSQL 16 image were not run here. CI is configured to run against PostgreSQL 16. No real Kapso account was used. Temporary HTTP, worker and database processes were stopped after the checks.

## Checks

| Command                               | Result                                                          |
| ------------------------------------- | --------------------------------------------------------------- |
| `npm ci`                              | Passed; clean lockfile install                                  |
| `npm run typecheck`                   | Passed                                                          |
| `npm run lint`                        | Passed; ESLint and Prettier                                     |
| `npm test`                            | Passed; 35 unit tests                                           |
| `npm run test:integration`            | Passed; 39 tests against real PostgreSQL                        |
| `npm run build`                       | Passed; JavaScript and type declarations                        |
| `npm audit --audit-level=high`        | Passed; zero reported vulnerabilities                           |
| `npm run db:migrate`                  | Passed; library and order tables                                |
| `npm run demo:single`                 | HTTP 200; one new message and order                             |
| `npm run demo:duplicates`             | Ten concurrent HTTP 200 responses; no new order                 |
| `npm run demo:batch`                  | HTTP 200; two new messages and orders                           |
| `npm run demo:batch-item`             | HTTP 200; duplicate item, no new order                          |
| `npm run demo:orders`                 | Showed one single order and two batch orders                    |
| `npm run example:worker`              | Recovered 50 messages stored while the worker was off           |
| `npm pack --dry-run --ignore-scripts` | Passed; built entry points, declarations, SQL and docs included |

The tests cover exact signed bytes, invalid signatures, wrong IDs, whole-batch rollback, commit-before-200, concurrent worker processes, SIGKILL recovery, retries, dead state, shutdown and transaction escape attempts. The README TypeScript snippet is extracted, compiled and run with signed requests.

In the stale worker test, one process blocks its JavaScript loop for two seconds. PostgreSQL ends its idle transaction. A successor commits within 1.5 seconds, before the old callback returns. The old transaction cannot leave its conflicting order behind. Shutdown tests also hold a database table lock and fill the connection pool.

## Measured ingestion run

The final benchmark used the receiver with its worker off. It used one PostgreSQL process on loopback and temporary local storage, not a container. There were 10 concurrent HTTP requests, one message per request, and bodies of 271–272 bytes. The worker count was zero during measurement.

| Measure              | Result   |
| -------------------- | -------- |
| Signed requests      | 100      |
| HTTP 200 responses   | 100      |
| Errors               | 0        |
| New durable messages | 50       |
| Duplicates           | 50       |
| p50 HTTP latency     | 3.67 ms  |
| p95 HTTP latency     | 38.52 ms |

The database showed 50 pending events while the worker was off. Starting `npm run example:worker` then completed them. These are small local measurements. They are not a production throughput claim.

## Run the checks again

Use Node.js 22 or 24 LTS. With Docker Compose installed:

```bash
npm ci
cp .env.example .env
docker compose up -d --wait
npm run db:migrate
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run build
npm audit --audit-level=high
npm run example
```

In another terminal:

```bash
npm run demo:single
npm run demo:duplicates
npm run demo:batch
npm run demo:batch-item
npm run demo:orders
npm run bench
```

If using an existing PostgreSQL server, create a separate test database and set `DATABASE_URL` and `TEST_DATABASE_URL`. Integration tests clear their test tables. Run only one integration suite against that test database at a time.

The package keeps the private placeholder name `@your-scope/event-sentinel`. Choose a real name before publishing. Database guarantees require the supplied transaction and normal durable PostgreSQL settings. External API calls can still happen more than once. See [guarantees and limits](guarantees.md).
