// Prints every TODO_VERIFY item in the rule library (apps/supabase/seed/rules/*.json) as a
// markdown checklist, for a contracts professional. The list in docs/contracts-rules.md is
// pasted from this output; re-run after editing a rule file:
//
//   cd apps/supabase/functions && deno task list-todo-verify

import { CONTRACT_FORM_LABEL, type ContractForm } from '../_shared/contracts/contractFieldSchema.ts';
import { ruleFileSchema, todoAttributes } from '../_shared/contracts/ruleSchema.ts';

const dir = new URL('../../seed/rules/', import.meta.url);
const names = [...Deno.readDirSync(dir)].filter((e) => e.name.endsWith('.json')).map((e) => e.name).sort();
let total = 0;
const out: string[] = [];
for (const name of names) {
  const file = ruleFileSchema.parse(JSON.parse(Deno.readTextFileSync(new URL(name, dir))));
  const rows = file.rules.map((r) => ({ r, todo: todoAttributes(r) })).filter((x) => x.todo.length);
  if (!rows.length) continue;
  const forms = [...new Set(file.rules.flatMap((r) => r.applies_to_contract_forms))];
  const title = forms.length === 1 ? CONTRACT_FORM_LABEL[forms[0] as ContractForm] : forms.join(', ');
  out.push(`#### \`seed/rules/${name}\`: ${title} (library ${file.library_version})`, '');
  out.push('| Rule key | Obligation | To check | Reviewer note |', '|---|---|---|---|');
  for (const { r, todo } of rows) {
    total += todo.length;
    const note = (r.notes ?? '').replace(/\|/g, '\\|');
    out.push(`| \`${r.rule_key}\` | ${r.obligation} | ${todo.map((t) => `\`${t}\``).join(', ')} | ${note} |`);
  }
  out.push('');
}
console.log(`${total} TODO_VERIFY attributes in ${names.length} rule files.\n`);
console.log(out.join('\n'));
