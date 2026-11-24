// Field extraction wire format: every task's output schema stays within the structured-output
// complexity limits, and the union-free field format decodes to the values the pipeline expects.

import { assert, assertEquals } from '@std/assert';

import { CONTRACT_FIELDS } from '../_shared/contracts/contractFieldSchema.ts';
import {
  amendmentsOutput,
  classifyOutput,
  describeFields,
  encodeField,
  fieldKeysOf,
  fieldsJsonSchema,
  fieldsOutput,
  proceduresOutput,
  processFieldOutput,
} from '../_shared/extraction/tasks.ts';
import { toStrictJsonSchema } from '../_shared/llm/json-schema.ts';

// Anthropic's documented per-request limits (structured outputs, "Schema complexity limits").
const MAX_UNION_PARAMS = 16;
const MAX_OPTIONAL_PARAMS = 24;

// deno-lint-ignore no-explicit-any
function complexity(schema: any): { unions: number; optional: number } {
  let unions = 0;
  let optional = 0;
  // deno-lint-ignore no-explicit-any
  const walk = (n: any) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if (n.properties) {
      const req = new Set(n.required ?? []);
      // deno-lint-ignore no-explicit-any
      for (const [k, v] of Object.entries<any>(n.properties)) {
        if (!req.has(k)) optional++;
        if (Array.isArray(v.type) || v.anyOf) unions++;
      }
    }
    if (n.items && (Array.isArray(n.items.type) || n.items.anyOf)) unions++;
    Object.values(n).forEach(walk);
  };
  walk(schema);
  return { unions, optional };
}

Deno.test('schemas: every task stays within the structured-output limits, even with all fields at once', () => {
  const schemas = {
    classify: toStrictJsonSchema(classifyOutput),
    fields_all: fieldsJsonSchema(CONTRACT_FIELDS),
    amendments: toStrictJsonSchema(amendmentsOutput),
    procedures: toStrictJsonSchema(proceduresOutput),
  };
  for (const [name, s] of Object.entries(schemas)) {
    const c = complexity(s);
    assert(c.unions <= MAX_UNION_PARAMS, `${name}: ${c.unions} union-typed parameters`);
    assert(c.optional <= MAX_OPTIONAL_PARAMS, `${name}: ${c.optional} optional parameters`);
  }
  assertEquals(complexity(schemas.fields_all), { unions: 0, optional: 0 });
});

Deno.test('fields wire format: decodes values, not-found, sentinels and duplicate keys; idempotent', () => {
  const wire = {
    fields: [
      encodeField('contract_sum', {
        value: { amount: 1200000, currency: 'SGD' },
        page_no: 2,
        source_excerpt: 'S$1,200,000',
        confidence: 0.9,
      }),
      {
        key: 'Employer_Name',
        found: true,
        value_json: 'Acme Pte Ltd',
        page_no: 1,
        source_excerpt: 'Acme',
        confidence: 0.8,
      },
      { key: 'retention_percent', found: false, value_json: '5', page_no: 3, source_excerpt: 'x', confidence: 0.7 },
      { key: 'completion_date', found: true, value_json: 'null', page_no: 0, source_excerpt: '', confidence: 0.6 },
      // Listed twice: the found one wins, whatever the order.
      { key: 'currency', found: true, value_json: '"SGD"', page_no: 2, source_excerpt: 'S$', confidence: 0.5 },
      { key: 'currency', found: false, value_json: 'null', page_no: 0, source_excerpt: '', confidence: 0.99 },
    ],
  };
  const out = fieldsOutput.parse(wire);
  assertEquals(out.fields.contract_sum, {
    value: { amount: 1200000, currency: 'SGD' },
    page_no: 2,
    source_excerpt: 'S$1,200,000',
    confidence: 0.9,
  });
  // A bare string that isn't JSON is kept as text; key casing is normalised.
  assertEquals(out.fields.employer_name.value, 'Acme Pte Ltd');
  // found: false wins over anything else in the item.
  assertEquals(out.fields.retention_percent, { value: null, page_no: null, source_excerpt: null, confidence: 0.7 });
  // found: true with a null value counts as not found.
  assertEquals(out.fields.completion_date.value, null);
  assertEquals(out.fields.currency.value, 'SGD');
  // Decoded output parses to itself (eval replay re-parses recorded data).
  assertEquals(fieldsOutput.parse(out), out);
});

Deno.test('fields schema: one fixed item whatever the number of fields; keys read back', () => {
  const small = fieldsJsonSchema(CONTRACT_FIELDS.slice(0, 2));
  const all = fieldsJsonSchema(CONTRACT_FIELDS);
  // Only the key enum grows with the number of fields.
  const strip = (s: unknown) => JSON.stringify(s).replace(/"enum":\[[^\]]*\]/, '');
  assertEquals(strip(small), strip(all));
  assertEquals(fieldKeysOf(all), CONTRACT_FIELDS.map((d) => d.key));
});

Deno.test('fields wire format: a value of the wrong shape is invalid for that field only', () => {
  const defs = CONTRACT_FIELDS.filter((d) => ['retention_percent', 'employer_name'].includes(d.key));
  const page = { page_no: 1, text: 'Employer: Acme Pte Ltd. Retention: five per cent', section: 'appendix' as const };
  const out = fieldsOutput.parse({
    fields: [
      {
        key: 'retention_percent',
        found: true,
        value_json: 'five',
        page_no: 1,
        source_excerpt: 'five per cent',
        confidence: 0.9,
      },
      {
        key: 'employer_name',
        found: true,
        value_json: '"Acme Pte Ltd"',
        page_no: 1,
        source_excerpt: 'Acme Pte Ltd',
        confidence: 0.9,
      },
    ],
  });
  const { proposals } = processFieldOutput(out, defs, [page], { provider: 'p', model: 'm' }, 0.7);
  const by = Object.fromEntries(proposals.map((p) => [p.field_key, p]));
  assertEquals(by.retention_percent.not_found_reason, 'invalid_value');
  assertEquals(by.employer_name.value, 'Acme Pte Ltd');
  assertEquals(by.employer_name.not_found_reason, null);
});

Deno.test('prompt field list shows each value shape', () => {
  const text = describeFields(CONTRACT_FIELDS.filter((d) => ['contract_sum', 'contract_period'].includes(d.key)));
  assert(text.includes('value_json: {"amount": number, "currency": string|null}'), text);
  assert(text.includes('"calendar_days"|"working_days"|"weeks"|"months"'), text);
});
