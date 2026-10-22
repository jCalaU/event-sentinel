import Fastify from 'fastify';
import type { EventSentinel } from '../../src/index.js';

export function buildServer({ sentinel }: { sentinel: EventSentinel }) {
  const app = Fastify({
    bodyLimit: 1024 * 1024,
    logger: false,
    requestTimeout: 10000,
  });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_request, body, done) => {
      done(null, body);
    },
  );
  app.setErrorHandler((error, _request, reply) => {
    const code = (error as { statusCode?: number }).statusCode;
    const status = code && code >= 400 && code < 500 ? code : 500;
    return reply.code(status).send({
      ok: false,
      error: status === 413 ? 'Request body too large' : 'Request rejected',
    });
  });
  app.post<{ Body: Buffer }>('/webhooks/kapso', async (request, reply) => {
    const result = await sentinel.ingest({
      rawBody: request.body,
      headers: request.headers,
    });
    return reply.code(result.statusCode).send(result.body);
  });
  return app;
}
