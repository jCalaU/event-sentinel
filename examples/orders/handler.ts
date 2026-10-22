import type { MessageHandler } from '../../src/index.js';

export const orderHandler: MessageHandler = async (event, ctx) => {
  const text = event.message.text?.body ?? '';
  const match = /^buy ([1-9][0-9]?) ([a-z][a-z-]{0,39})$/i.exec(text.trim());
  if (!match) return;
  await ctx.transaction.query(
    `INSERT INTO orders (message_id, product, quantity) VALUES ($1, $2, $3)
     ON CONFLICT (message_id) DO NOTHING`,
    [event.message.id, match[2]!.toLowerCase(), Number(match[1])],
  );
};
