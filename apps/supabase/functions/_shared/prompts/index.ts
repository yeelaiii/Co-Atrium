// Versioned prompt files (<task>.<version>.md). Bump the version by adding a new file and
// changing PROMPT_VERSIONS; the version is recorded on every extraction_calls row.
// Prompts are provider-neutral plain text: no provider-specific syntax.

import type { TaskName } from '../llm/config-schema.ts';

export const PROMPT_VERSIONS: Record<TaskName, string> = {
  classify: 'v1',
  identify_contract: 'v2',
  extract_fields: 'v2',
  extract_amendments: 'v1',
  extract_procedures: 'v1',
};

const cache = new Map<TaskName, string>();

export async function loadPrompt(
  task: TaskName,
  vars: Record<string, string> = {},
): Promise<{ text: string; version: string }> {
  const version = PROMPT_VERSIONS[task];
  let text = cache.get(task);
  if (text === undefined) {
    text = await Deno.readTextFile(new URL(`./${task}.${version}.md`, import.meta.url));
    cache.set(task, text);
  }
  for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{{${k}}}`, v);
  if (/\{\{[A-Z_]+\}\}/.test(text)) throw new Error(`Prompt ${task}.${version} has an unfilled placeholder`);
  return { text, version: `${task}.${version}` };
}
