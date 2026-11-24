// Zod -> the strict JSON Schema subset that every structured-output API accepts:
//   * every object has additionalProperties: false and lists all its properties in `required`
//     (optional properties become nullable instead);
//   * no numeric / length / pattern / format constraints (zod checks those afterwards);
//   * oneOf -> anyOf; no defaults, titles or $schema.
// The output is still validated with the original zod schema by the router, so dropping
// constraints here only loosens what the model is steered towards, never what we accept.

import { z } from 'zod';

type Json = Record<string, unknown>;

const DROP = new Set([
  '$schema',
  'default',
  'title',
  'examples',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'propertyNames',
  'patternProperties',
  'contentEncoding',
  'contentMediaType',
]);

function nullable(s: Json): Json {
  if (s.type === 'null') return s;
  if (typeof s.type === 'string' && !s.enum && !s.const) return { ...s, type: [s.type, 'null'] };
  if (Array.isArray(s.type) && !s.enum && !s.const) {
    return s.type.includes('null') ? s : { ...s, type: [...s.type, 'null'] };
  }
  if (Array.isArray(s.anyOf)) {
    return (s.anyOf as Json[]).some((x) => x.type === 'null')
      ? s
      : { ...s, anyOf: [...(s.anyOf as Json[]), { type: 'null' }] };
  }
  const { description, ...rest } = s;
  return { ...(description ? { description } : {}), anyOf: [rest, { type: 'null' }] };
}

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (!node || typeof node !== 'object') return node;
  const s = node as Json;
  const out: Json = {};
  for (const [k, v] of Object.entries(s)) {
    if (DROP.has(k)) continue;
    if (k === 'oneOf') out.anyOf = strictify(v);
    else if (k === 'properties' || k === '$defs' || k === 'definitions') {
      out[k] = Object.fromEntries(Object.entries(v as Json).map(([pk, pv]) => [pk, strictify(pv)]));
    } else out[k] = strictify(v);
  }
  // A const inside a union arrives as { type, const }: fine for both APIs, keep it.
  if (out.type === 'object' || out.properties) {
    const props = (out.properties ?? {}) as Json;
    const required = new Set((s.required as string[] | undefined) ?? []);
    for (const key of Object.keys(props)) {
      if (!required.has(key)) props[key] = nullable(props[key] as Json);
    }
    out.type = 'object';
    out.properties = props;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  // `{ anyOf: [X] }` -> X
  if (Array.isArray(out.anyOf) && out.anyOf.length === 1 && Object.keys(out).length === 1) return out.anyOf[0];
  return out;
}

/** Strict JSON Schema for a zod schema (root must be an object). */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' }) as Json;
  const strict = strictify(raw) as Json;
  if (strict.type !== 'object') throw new Error('Structured output schemas must have an object at the root');
  return strict;
}

/** Removes object keys whose value is null, recursively (for `optional()` fields the model filled with null). */
export function stripNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(
    Object.entries(v as Json).filter(([, x]) => x !== null).map(([k, x]) => [k, stripNulls(x)]),
  );
}

/**
 * Parses with the original schema, tolerating nulls the strict schema forced onto optional
 * properties: tries as-is first, then with nulls removed.
 */
export function safeParseLenient<T>(schema: z.ZodType<T>, data: unknown): z.ZodSafeParseResult<T> {
  const first = schema.safeParse(data);
  if (first.success) return first;
  const second = schema.safeParse(stripNulls(data));
  return second.success ? second : first;
}
