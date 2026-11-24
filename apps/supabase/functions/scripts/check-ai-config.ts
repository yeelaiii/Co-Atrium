// deno task check-config: loads ai-config.ts (which validates itself on import) and prints a
// summary. Exits non-zero, listing every problem, if the config is invalid.

try {
  const { aiConfig } = await import('../_shared/llm/ai-config.ts');
  const p = (ref: { provider: string; model: string }) =>
    `${ref.provider}:${ref.model} (${aiConfig.providers[ref.provider].region})`;
  console.log('ai-config is valid');
  console.log(`  allowed regions: ${aiConfig.allowed_provider_regions.join(', ')}`);
  for (const [task, ref] of Object.entries(aiConfig.tasks)) console.log(`  ${task.padEnd(20)} ${p(ref)}`);
  console.log(`  ${'fallback'.padEnd(20)} ${aiConfig.fallback ? p(aiConfig.fallback) : 'none'}`);
  console.log(`  ${'escalation'.padEnd(20)} ${aiConfig.escalation.enabled ? p(aiConfig.escalation.target) : 'off'}`);
  console.log(
    `  ${'ocr'.padEnd(20)} ${aiConfig.ocr.enabled ? `${aiConfig.ocr.provider} (${aiConfig.ocr.region})` : 'off'}`,
  );
  const unpriced = new Set(
    [...Object.values(aiConfig.tasks), aiConfig.fallback, aiConfig.escalation.target]
      .filter((r): r is { provider: string; model: string } => !!r)
      .map((r) => r.model)
      .filter((m) => !aiConfig.pricing_usd_per_mtok[m]),
  );
  if (unpriced.size) console.log(`  note: no price for ${[...unpriced].join(', ')} (cost estimates will be empty)`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  Deno.exit(1);
}
