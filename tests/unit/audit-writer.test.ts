// tests/unit/audit-writer.test.ts
//
// The one place an audit row is written.
//
// WHY THIS FILE EXISTS
// --------------------
// The audit trail is evidence. A row that is lost is not a row that is
// inconvenient — it is an action that happened and left no trace, which is
// the one thing an audit trail exists to prevent.
//
// The write used to be made by twenty-eight places, twenty-four of which
// threw the result away:
//
//     await sb.rpc('log_audit', { … });       // ← the error was never read
//
// So when the write was refused — which it was, for every system action,
// because the service principal is deliberately not a user and the actor
// column has a foreign key to `auth.users` — the trail did not fail. It was
// silently never written.
//
// WHAT IS PROVED HERE
// -------------------
// The writer:
//
//   * passes the row through to the RPC with the fields it was given;
//   * does NOT throw when the write is refused — a logging failure must not
//     roll back the action that was being logged, which is the rule the
//     existing `recordAudit` has always followed;
//   * says so, in the log, when the write is refused.
//
// The failure is not swallowed. It is reported. It is just not allowed to
// become somebody else's error.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendAudit } from '@/lib/audit';

describe('the audit writer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A client that records what it was asked to write. */
  function stubClient(result: { error: { message: string } | null }) {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    return {
      calls,
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        return result;
      },
    };
  }

  it('writes the row it was given', async () => {
    const client = stubClient({ error: null });

    await appendAudit(client as never, {
      tenantId: 'b1111111-1111-1111-1111-111111111111',
      action: 'thing.done',
      entityType: 'thing',
      entityId: 'c2222222-2222-2222-2222-222222222222',
      detail: { amount: 100 },
      actor: 'd3333333-3333-3333-3333-333333333333',
    });

    expect(client.calls.length).toBe(1);
    expect(client.calls[0].fn).toBe('log_audit');
    expect(client.calls[0].args).toMatchObject({
      p_tenant: 'b1111111-1111-1111-1111-111111111111',
      p_action: 'thing.done',
      p_entity_type: 'thing',
      p_entity_id: 'c2222222-2222-2222-2222-222222222222',
      p_detail: { amount: 100 },
      p_actor: 'd3333333-3333-3333-3333-333333333333',
    });
  });

  it('leaves the actor out when there is none', async () => {
    // A system action has no actor, and the actor column has a foreign key —
    // so passing a made-up one would have the whole row refused. The writer
    // passes nothing rather than something wrong.
    const client = stubClient({ error: null });

    await appendAudit(client as never, {
      tenantId: 'b1111111-1111-1111-1111-111111111111',
      action: 'thing.done',
      detail: {},
      actor: null,
    });

    expect(client.calls[0].args.p_actor).toBeUndefined();
    expect(client.calls[0].args.p_detail).toEqual({});
  });

  it('does not throw when the write is refused', async () => {
    // The rule the existing `recordAudit` has always followed: an audit
    // failure is logged, not propagated. The action that was being logged has
    // already happened, and making the person who did it see an error for it
    // would be worse than the missing row.
    const logged: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });

    const client = stubClient({ error: { message: 'insert or update on table "audit_log" …' } });

    await expect(
      appendAudit(client as never, {
        tenantId: 'b1111111-1111-1111-1111-111111111111',
        action: 'thing.done',
        detail: {},
      }),
    ).resolves.toBeUndefined();

    expect(logged.length, 'the refusal was not reported').toBe(1);
    expect(String(logged[0][0])).toContain('audit');
    expect(String(logged[0][1])).toContain('thing.done');
  });

  it('does not throw when the client fails outright', async () => {
    // The client can fail before it gets to answer — a connection refused, a
    // timeout. That is the same situation as a refusal: the row is not
    // written, and the action still stands.
    const logged: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });

    const client = {
      rpc: async () => {
        throw new Error('connection refused');
      },
    };

    await expect(
      appendAudit(client as never, {
        tenantId: 'b1111111-1111-1111-1111-111111111111',
        action: 'thing.done',
        detail: {},
      }),
    ).resolves.toBeUndefined();

    expect(logged.length, 'the failure was not reported').toBe(1);
  });

  it('says nothing when the write went through', async () => {
    // The negative control for the two tests above: a writer that logged
    // every write would drown the failures in noise, which is how a real
    // failure gets missed.
    const logged: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });

    const client = stubClient({ error: null });

    await appendAudit(client as never, {
      tenantId: 'b1111111-1111-1111-1111-111111111111',
      action: 'thing.done',
      detail: {},
    });

    expect(logged).toEqual([]);
  });
});
