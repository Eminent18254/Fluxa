/**
 * A Supabase client that records instead of connecting.
 *
 * The data layer's job is to send the right request. Whether it does can be
 * checked without a database, and it is worth checking without one, because the
 * failures that matter here are invisible in a happy-path integration test:
 *
 *   - a search term with a comma in it, silently reinterpreted as `or=` syntax
 *   - a checksummed address written straight from wagmi, rejected by a CHECK
 *   - a `merchant_id` filter added "for safety", quietly implying RLS is optional
 *   - an update that matched zero rows, reported as success
 *
 * So every call is captured as a plain object and the test asserts on it. The
 * responder decides what comes back, which is how the zero-row and error paths get
 * exercised at all — a live database would only produce them by arrangement.
 *
 * This is not a PostgREST emulator. It does not filter, sort or paginate; it
 * remembers that it was asked to. Anything that depends on Postgres actually
 * behaving like Postgres — the RLS policies, the CHECK constraints, the SECURITY
 * DEFINER functions — is proved against a real database, not here.
 */
import { PostgrestError } from '@supabase/supabase-js';

import type { FluxaClient } from '@/lib/supabase';

export type StubFilter = {
  op: 'eq' | 'in' | 'gte' | 'lte' | 'or' | 'is';
  column: string;
  value: unknown;
};

export type StubOrder = { column: string; ascending: boolean };

export type RecordedCall = {
  kind: 'query' | 'rpc';
  /** Table name for a query. */
  table: string;
  /** Function name for an rpc. */
  fn: string;
  /** Arguments object for an rpc. */
  args: unknown;
  method: 'select' | 'insert' | 'update' | 'delete';
  /** The column list as the layer wrote it, so `select('*')` is visible as such. */
  columns: string;
  count: string | null;
  head: boolean;
  /** The insert or update body. */
  payload: unknown;
  filters: StubFilter[];
  order: StubOrder[];
  range: { from: number; to: number } | null;
  single: 'single' | 'maybeSingle' | null;
};

export type StubResponse = {
  data?: unknown;
  error?: PostgrestError | null;
  count?: number | null;
};

/** Decides what a recorded call returns. Called once per awaited query. */
export type Responder = (call: RecordedCall) => StubResponse;

/** A PostgrestError with a real SQLSTATE, for the error-path tests. */
export function pgError(code: string, message: string, details = '', hint = ''): PostgrestError {
  return new PostgrestError({ message, details, hint, code });
}

function blankCall(overrides: Partial<RecordedCall>): RecordedCall {
  return {
    kind: 'query',
    table: '',
    fn: '',
    args: undefined,
    method: 'select',
    columns: '',
    count: null,
    head: false,
    payload: undefined,
    filters: [],
    order: [],
    range: null,
    single: null,
    ...overrides,
  };
}

/**
 * The chainable half of the stub.
 *
 * Awaitable via `then`, because that is how supabase-js queries are consumed:
 * there is no `.execute()`, the builder is itself a thenable, and a stub that
 * needed one would not be substitutable.
 */
class StubQuery implements PromiseLike<StubResponse> {
  constructor(
    private readonly call: RecordedCall,
    private readonly respond: Responder,
  ) {}

  select(columns: string, opts?: { count?: string; head?: boolean }): this {
    this.call.columns = columns;
    if (opts?.count !== undefined) this.call.count = opts.count;
    if (opts?.head !== undefined) this.call.head = opts.head;
    return this;
  }

  insert(payload: unknown): this {
    this.call.method = 'insert';
    this.call.payload = payload;
    return this;
  }

  update(payload: unknown): this {
    this.call.method = 'update';
    this.call.payload = payload;
    return this;
  }

  delete(): this {
    this.call.method = 'delete';
    return this;
  }

  eq(column: string, value: unknown): this {
    this.call.filters.push({ op: 'eq', column, value });
    return this;
  }

  in(column: string, value: unknown): this {
    this.call.filters.push({ op: 'in', column, value });
    return this;
  }

  gte(column: string, value: unknown): this {
    this.call.filters.push({ op: 'gte', column, value });
    return this;
  }

  lte(column: string, value: unknown): this {
    this.call.filters.push({ op: 'lte', column, value });
    return this;
  }

  is(column: string, value: unknown): this {
    this.call.filters.push({ op: 'is', column, value });
    return this;
  }

  or(expression: string): this {
    this.call.filters.push({ op: 'or', column: '', value: expression });
    return this;
  }

  order(column: string, opts?: { ascending?: boolean }): this {
    this.call.order.push({ column, ascending: opts?.ascending ?? true });
    return this;
  }

  range(from: number, to: number): this {
    this.call.range = { from, to };
    return this;
  }

  limit(count: number): this {
    this.call.range = { from: 0, to: count - 1 };
    return this;
  }

  single(): this {
    this.call.single = 'single';
    return this;
  }

  maybeSingle(): this {
    this.call.single = 'maybeSingle';
    return this;
  }

  then<TResult1 = StubResponse, TResult2 = never>(
    onFulfilled?: ((value: StubResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const result = this.respond(this.call);
    return Promise.resolve({
      data: result.data ?? null,
      error: result.error ?? null,
      count: result.count ?? null,
    }).then(onFulfilled, onRejected);
  }
}

export type SupabaseStub = {
  /** The client to pass to the layer. */
  db: FluxaClient;
  /** Every call made, in order. */
  calls: RecordedCall[];
  /** The single call made, asserting there was exactly one. */
  only: () => RecordedCall;
};

/**
 * A recording client.
 *
 * The cast is unavoidable and deliberately narrow in effect: the stub implements
 * only the builder methods this layer actually uses, so a query that reaches for
 * something else fails loudly as "not a function" rather than passing with a
 * silently wrong request. A hand-written full `SupabaseClient` would be a larger
 * lie than this cast is.
 */
export function supabaseStub(respond: Responder): SupabaseStub {
  const calls: RecordedCall[] = [];

  const client = {
    from(table: string) {
      const call = blankCall({ kind: 'query', table });
      calls.push(call);
      return new StubQuery(call, respond);
    },
    rpc(fn: string, args: unknown) {
      const call = blankCall({ kind: 'rpc', fn, args });
      calls.push(call);
      return new StubQuery(call, respond);
    },
  };

  return {
    db: client as unknown as FluxaClient,
    calls,
    only: () => {
      if (calls.length !== 1) {
        throw new Error(`expected exactly one database call, saw ${calls.length}`);
      }
      // Checked immediately above; the index is in range.
      return calls[0] as RecordedCall;
    },
  };
}

/** A stub that answers every call the same way. Enough for most assertions. */
export function stubReturning(response: StubResponse): SupabaseStub {
  return supabaseStub(() => response);
}
