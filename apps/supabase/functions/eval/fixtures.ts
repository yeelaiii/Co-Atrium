// Synthetic contract fixtures (tests/fixtures/contracts/<name>/) and their golden answers.
//
//   pages.md       the source text, pages separated by a line "--- page ---" (written for these
//                  tests; fictional parties, no real contract text)
//   contract.pdf   built from pages.md by scripts/build-fixtures.ts (a rasterised scan when
//                  expected.json says scanned: true)
//   expected.json  golden answers: every field the document states, with page and excerpt.
//                  Any field not listed (and not in `ignore`) is expected to be NOT FOUND, so a
//                  value returned for it counts as invented.
//   oracle.json    scripted mistakes for the offline reference run (eval/oracle.ts)

import { z } from 'zod';

import { CONTRACT_FIELDS, FIELD_BY_KEY, validateFieldValue } from '../_shared/contracts/contractFieldSchema.ts';
import { checkCitation, MAX_EXCERPT_WORDS, wordCount } from '../_shared/extraction/guards.ts';
import { PROCEDURE_KINDS } from '../_shared/extraction/tasks.ts';
import { SECTIONS } from '../_shared/extraction/sections.ts';

export const FIXTURES_DIR = new URL('../tests/fixtures/contracts/', import.meta.url);
export const PAGE_BREAK = /^--- page ---$/m;

const unit = z.enum(['calendar_days', 'working_days', 'weeks', 'months']);

const expectedField = z.object({
  value: z.unknown(),
  page: z.number().int().positive(),
  excerpt: z.string().min(1),
  /** exact (default): equal after normalisation. keywords: every keyword appears in the value. */
  match: z.enum(['exact', 'keywords']).default('exact'),
  keywords: z.array(z.string().min(1)).optional(),
  /** Other values that also count as correct (exact match). */
  accept: z.array(z.unknown()).optional(),
}).strict();
export type ExpectedField = z.infer<typeof expectedField>;

const expectedRule = z.object({
  group_key: z.string(),
  clause: z.string().nullable(),
  period: z.number().int().min(0),
  unit,
  page: z.number().int().positive(),
  summary: z.string().min(3),
  excerpt: z.string().min(1),
}).strict();

const expectedProcedure = z.object({
  kind: z.enum(PROCEDURE_KINDS),
  period: z.number().int().min(0).nullable(),
  unit: unit.nullable(),
  page: z.number().int().positive(),
  summary: z.string().min(3),
  excerpt: z.string().min(1),
}).strict();

export const expectedSchema = z.object({
  description: z.string(),
  document: z.string(),
  mime: z.string(),
  scanned: z.boolean(),
  /** Sections for pages the heading rules can't place (what a correct classifier answers). */
  sections: z.record(z.string().regex(/^\d+$/), z.enum(SECTIONS)),
  fields: z.record(z.string(), expectedField),
  /** Fields left out of scoring because the document is ambiguous about them. */
  ignore: z.array(z.string()),
  amendments: z.array(expectedRule),
  procedures: z.array(expectedProcedure),
}).strict();
export type Expected = z.infer<typeof expectedSchema>;

const oracleAnswer = z.object({
  value: z.unknown(),
  page: z.number().int().positive(),
  excerpt: z.string(),
  confidence: z.number().min(0).max(1),
  why: z.string().optional(),
}).strict();
export type OracleAnswer = z.infer<typeof oracleAnswer>;

export const oracleSchema = z.object({
  note: z.string().optional(),
  answers: z.record(z.string(), oracleAnswer),
  ocr_slips: z.array(z.object({ page: z.number().int().positive(), from: z.string(), to: z.string() })).optional(),
}).strict();
export type OracleScript = z.infer<typeof oracleSchema>;

export interface Fixture {
  name: string;
  pages: string[];
  expected: Expected;
  oracle: OracleScript;
  /** The contract form the golden answers name (used to load the project's rules). */
  form: string;
  dir: URL;
}

export function parsePages(md: string): string[] {
  return md.split(PAGE_BREAK).map((p) => p.trim());
}

export async function listFixtures(): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(FIXTURES_DIR)) if (e.isDirectory) out.push(e.name);
  return out.sort();
}

export async function loadFixture(name: string): Promise<Fixture> {
  const dir = new URL(`${name}/`, FIXTURES_DIR);
  const pages = parsePages(await Deno.readTextFile(new URL('pages.md', dir)));
  const expected = expectedSchema.parse(JSON.parse(await Deno.readTextFile(new URL('expected.json', dir))));
  let oracle: OracleScript = { answers: {} };
  try {
    oracle = oracleSchema.parse(JSON.parse(await Deno.readTextFile(new URL('oracle.json', dir))));
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  const problems = validateFixture(pages, expected, oracle);
  if (problems.length) throw new Error(`Fixture ${name} is invalid:\n  - ${problems.join('\n  - ')}`);
  const form = expected.fields.contract_form?.value;
  return { name, pages, expected, oracle, form: typeof form === 'string' ? form : 'UNKNOWN', dir };
}

export async function fixtureBytes(f: Fixture): Promise<Uint8Array> {
  return await Deno.readFile(new URL(f.expected.document, f.dir));
}

/**
 * Checks a fixture against itself: golden values match the field schema, every excerpt is at
 * most 25 words and appears on the cited page, oracle answers have valid values.
 */
export function validateFixture(pages: string[], exp: Expected, oracle: OracleScript): string[] {
  const out: string[] = [];
  const pageMap = new Map(pages.map((t, i) => [i + 1, t]));
  const cite = (what: string, page: number, excerpt: string) => {
    const fail = checkCitation({ page_no: page, source_excerpt: excerpt }, pageMap);
    if (fail) out.push(`${what}: excerpt fails the guard (${fail}) on page ${page}`);
  };
  for (const [k, f] of Object.entries(exp.fields)) {
    if (!FIELD_BY_KEY.has(k)) {
      out.push(`fields.${k}: not a contract field`);
      continue;
    }
    const v = validateFieldValue(k, f.value);
    if (!v.ok) out.push(`fields.${k}: ${v.error}`);
    if (f.match === 'keywords' && !f.keywords?.length) out.push(`fields.${k}: match keywords needs keywords`);
    if (wordCount(f.excerpt) > MAX_EXCERPT_WORDS) out.push(`fields.${k}: excerpt over ${MAX_EXCERPT_WORDS} words`);
    cite(`fields.${k}`, f.page, f.excerpt);
    if (exp.ignore.includes(k)) out.push(`fields.${k}: both expected and ignored`);
  }
  for (const k of exp.ignore) if (!FIELD_BY_KEY.has(k)) out.push(`ignore: ${k} is not a contract field`);
  exp.amendments.forEach((a, i) => cite(`amendments[${i}]`, a.page, a.excerpt));
  exp.procedures.forEach((p, i) => cite(`procedures[${i}]`, p.page, p.excerpt));
  for (const [k, a] of Object.entries(oracle.answers)) {
    if (!FIELD_BY_KEY.has(k)) out.push(`oracle.answers.${k}: not a contract field`);
    else if (a.value !== null) {
      const v = validateFieldValue(k, a.value);
      if (!v.ok) out.push(`oracle.answers.${k}: ${v.error}`);
    }
  }
  for (const s of oracle.ocr_slips ?? []) {
    if (!pageMap.get(s.page)?.includes(s.from)) out.push(`oracle.ocr_slips: "${s.from}" is not on page ${s.page}`);
  }
  return out;
}

/** The scored fields of a fixture: golden value or null (= expected not found). */
export function scoredFields(exp: Expected): { key: string; expected: ExpectedField | null }[] {
  return CONTRACT_FIELDS.filter((d) => !exp.ignore.includes(d.key)).map((d) => ({
    key: d.key,
    expected: exp.fields[d.key] ?? null,
  }));
}
