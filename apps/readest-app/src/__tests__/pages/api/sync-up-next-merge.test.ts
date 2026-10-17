import { describe, expect, it } from 'vitest';
import { resolveUpNextOrderMerge } from '@/pages/api/sync';

const iso = (ms: number) => new Date(ms).toISOString();

describe('resolveUpNextOrderMerge', () => {
  it('keeps the side whose Up Next timestamp is newer', () => {
    const client = { up_next_order: 0, up_next_order_updated_at: iso(200) };
    const server = { up_next_order: 3, up_next_order_updated_at: iso(100) };
    expect(resolveUpNextOrderMerge(client, server)).toEqual(client);
    expect(resolveUpNextOrderMerge(server, client)).toEqual(client);
  });

  it('never lets an unstamped push (old clients, plugins) erase a position', () => {
    const server = { up_next_order: 2, up_next_order_updated_at: iso(1) };
    expect(resolveUpNextOrderMerge({}, server)).toEqual(server);
  });

  it('prefers the client on a tie', () => {
    const client = { up_next_order: 1, up_next_order_updated_at: iso(5) };
    const server = { up_next_order: 2, up_next_order_updated_at: iso(5) };
    expect(resolveUpNextOrderMerge(client, server).up_next_order).toBe(1);
  });
});
