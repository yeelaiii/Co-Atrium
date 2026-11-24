// In-memory stand-in for the subset of supabase-js the deadline engine uses, so the engine's
// I/O can be tested without a database. Enforces the unique keys the engine relies on and
// mirrors the close_obligations_on_response trigger. Not a general PostgREST emulator.

import { closesObligation } from '../../_shared/deadlines/index.ts';

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
type Filter = (r: Row) => boolean;

const UNIQUE: Record<string, ((r: Row) => string | null)[]> = {
  obligations: [
    (r) => (r.anchor === 'event' ? `e:${r.project_id}:${r.group_key}:${r.trigger_event_id}` : null),
    (r) => (r.anchor === 'completion_date' ? `c:${r.project_id}:${r.group_key}` : null),
    (r) => (r.anchor === 'chained' ? `x:${r.group_key}:${r.parent_obligation_id}` : null),
    (r) => (r.anchor === 'variation' ? `v:${r.group_key}:${r.variation_order_id}` : null),
  ],
  reminders_sent: [(r) => `${r.obligation_id}:${r.user_id}:${r.reminder_key}:${r.channel}`],
};

const DEFAULTS: Record<string, () => Row> = {
  obligations: () => ({ status: 'open', variation_order_id: null, parent_obligation_id: null, closed_by_event_id: null, subject: null }),
  obligation_queue: () => ({ attempts: 0, processed_at: null, last_error: null, event_id: null }),
  project_events: () => ({ voided_at: null, served_at: null, related_event_id: null, reference: null, variation_order_id: null, time_extension_days: null }),
  notifications: () => ({ read_at: null }),
};

export class FakeDb {
  tables: Record<string, Row[]> = {};
  now = () => new Date();
  private seq = 0;

  table(name: string): Row[] {
    return (this.tables[name] ??= []);
  }

  seed(name: string, rows: Row[]) {
    for (const r of rows) this.insertRow(name, r);
  }

  insertRow(name: string, input: Row): { row?: Row; dup?: boolean } {
    const row: Row = { id: input.id ?? `${name}-${++this.seq}`, created_at: this.now().toISOString(), ...DEFAULTS[name]?.(), ...input };
    for (const key of UNIQUE[name] ?? []) {
      const k = key(row);
      if (k && this.table(name).some((r) => key(r) === k)) return { dup: true };
    }
    this.table(name).push(row);
    if (name === 'project_events') this.closeOnResponse(row);
    return { row };
  }

  /** Mirrors the close_obligations_on_response trigger (migration 0020). */
  private closeOnResponse(ev: Row) {
    for (const o of this.table('obligations')) {
      if (o.project_id !== ev.project_id || !o.trigger_event_id) continue;
      const trigger = this.table('project_events').find((e) => e.id === o.trigger_event_id);
      if (
        closesObligation(
          { triggerEventId: o.trigger_event_id, closedByEventTypes: o.closed_by_event_types ?? [], status: o.status, triggerReference: trigger?.reference ?? null },
          { eventType: ev.event_type, relatedEventId: ev.related_event_id ?? null, reference: ev.reference ?? null },
        )
      ) {
        Object.assign(o, { status: 'met', closed_by_event_id: ev.id, closed_at: this.now().toISOString() });
      }
    }
  }

  from(name: string) {
    return new Query(this, name);
  }
}

class Query implements PromiseLike<{ data: unknown; error: unknown }> {
  private op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
  private filters: Filter[] = [];
  private payload: Row | Row[] | null = null;
  private opts: { ignoreDuplicates?: boolean } = {};
  private single = false;
  private returning = false;
  private max: number | null = null;
  private orderBy: string | null = null;

  constructor(private db: FakeDb, private name: string) {}

  select(_cols?: string) {
    if (this.op !== 'select') this.returning = true;
    return this;
  }
  insert(p: Row | Row[]) {
    this.op = 'insert';
    this.payload = p;
    return this;
  }
  update(p: Row) {
    this.op = 'update';
    this.payload = p;
    return this;
  }
  upsert(p: Row[], opts: { ignoreDuplicates?: boolean } = {}) {
    this.op = 'upsert';
    this.payload = p;
    this.opts = opts;
    return this;
  }
  delete() {
    this.op = 'delete';
    return this;
  }
  eq(c: string, v: unknown) {
    this.filters.push((r) => r[c] === v);
    return this;
  }
  neq(c: string, v: unknown) {
    this.filters.push((r) => r[c] !== v);
    return this;
  }
  is(c: string, v: null) {
    this.filters.push((r) => (r[c] ?? null) === v);
    return this;
  }
  in(c: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(r[c]));
    return this;
  }
  lt(c: string, v: string) {
    this.filters.push((r) => r[c] < v);
    return this;
  }
  gt(c: string, v: string) {
    this.filters.push((r) => r[c] > v);
    return this;
  }
  order(c: string) {
    this.orderBy = c;
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }

  private run(): { data: unknown; error: unknown } {
    const rows = this.db.table(this.name);
    const match = () => rows.filter((r) => this.filters.every((f) => f(r)));
    switch (this.op) {
      case 'select': {
        let out = match().map((r) => ({ ...r }));
        if (this.orderBy) out.sort((a, b) => String(a[this.orderBy!]).localeCompare(String(b[this.orderBy!])));
        if (this.max !== null) out = out.slice(0, this.max);
        return { data: this.single ? out[0] ?? null : out, error: null };
      }
      case 'insert': {
        const list = Array.isArray(this.payload) ? this.payload : [this.payload!];
        const inserted: Row[] = [];
        for (const p of list) {
          const res = this.db.insertRow(this.name, p);
          if (res.dup) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          inserted.push(res.row!);
        }
        return { data: this.returning ? inserted : null, error: null };
      }
      case 'upsert': {
        const inserted: Row[] = [];
        for (const p of this.payload as Row[]) {
          const res = this.db.insertRow(this.name, p);
          if (res.dup && !this.opts.ignoreDuplicates) return { data: null, error: { code: '23505' } };
          if (res.row) inserted.push(res.row);
        }
        return { data: this.returning ? inserted : null, error: null };
      }
      case 'update': {
        for (const r of match()) Object.assign(r, this.payload);
        return { data: null, error: null };
      }
      case 'delete': {
        const keep = rows.filter((r) => !this.filters.every((f) => f(r)));
        this.db.tables[this.name] = keep;
        return { data: null, error: null };
      }
    }
  }

  then<A, B>(ok?: ((v: { data: unknown; error: unknown }) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.run()).then(ok, bad);
  }
}
