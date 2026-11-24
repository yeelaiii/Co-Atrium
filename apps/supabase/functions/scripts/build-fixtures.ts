// Builds tests/fixtures/contracts/<name>/contract.pdf from pages.md, then checks the result:
//   * text fixtures: a PDF with a text layer (pdf-lib, fixed metadata so the bytes are
//     reproducible); every golden excerpt must pass the excerpt guard against the text the
//     pipeline will actually extract (unpdf), on the cited page;
//   * scanned fixtures (expected.json scanned: true): every page rasterised to an image with no
//     text layer, by scripts/rasterise-fixture.py (needs python3 + Pillow); the check is that no
//     page has a usable text layer.
//
//   cd apps/supabase/functions
//   deno task build-fixtures            # build + check
//   deno task build-fixtures --check    # check the committed PDFs only

import { PDFDocument, StandardFonts } from 'pdf-lib';

import { checkCitation } from '../_shared/extraction/guards.ts';
import { pdfPages } from '../_shared/extraction/text.ts';
import { aiConfig } from '../_shared/llm/ai-config.ts';
import { type Fixture, FIXTURES_DIR, listFixtures, loadFixture } from '../eval/fixtures.ts';

const checkOnly = Deno.args.includes('--check');
const FIXED_DATE = new Date('2026-01-01T00:00:00Z');

function wrap(line: string, max = 92): string[] {
  const out: string[] = [];
  let cur = '';
  for (const w of line.split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + w.length > max) {
      out.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

export async function textPdf(pages: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('Synthetic contract fixture');
  doc.setProducer('co-atrium build-fixtures');
  doc.setCreator('co-atrium build-fixtures');
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const text of pages) {
    const page = doc.addPage([595, 842]); // A4
    let y = 790;
    text.split('\n').forEach((line, i) => {
      for (const part of wrap(line)) {
        page.drawText(part, { x: 50, y, size: i === 0 ? 13 : 10, font: i === 0 ? bold : font });
        y -= i === 0 ? 22 : 15;
      }
      if (i === 0) y -= 4;
    });
  }
  return await doc.save({ useObjectStreams: false });
}

async function rasterise(fx: Fixture, out: URL) {
  const script = new URL('./rasterise-fixture.py', import.meta.url).pathname;
  const cmd = new Deno.Command('python3', {
    args: ['-E', script, new URL('pages.md', fx.dir).pathname, out.pathname],
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const { code } = await cmd.output();
  if (code !== 0) throw new Error(`rasterise-fixture.py failed for ${fx.name} (needs python3 with Pillow)`);
}

async function check(fx: Fixture): Promise<string[]> {
  const problems: string[] = [];
  const bytes = await Deno.readFile(new URL(fx.expected.document, fx.dir));
  const texts = await pdfPages(bytes);
  if (texts.length !== fx.pages.length) problems.push(`${texts.length} PDF pages, pages.md has ${fx.pages.length}`);
  if (fx.expected.scanned) {
    const min = aiConfig.ocr.min_chars_per_page;
    texts.forEach((t, i) => {
      if (t.replace(/\s/g, '').length >= min) problems.push(`page ${i + 1} has a text layer (a scan must not)`);
    });
    return problems;
  }
  const pageMap = new Map(texts.map((t, i) => [i + 1, t]));
  const cite = (what: string, page: number, excerpt: string) => {
    const f = checkCitation({ page_no: page, source_excerpt: excerpt }, pageMap);
    if (f) problems.push(`${what}: ${f} against the extracted text of page ${page}`);
  };
  for (const [k, f] of Object.entries(fx.expected.fields)) cite(`fields.${k}`, f.page, f.excerpt);
  fx.expected.amendments.forEach((a, i) => cite(`amendments[${i}]`, a.page, a.excerpt));
  fx.expected.procedures.forEach((p, i) => cite(`procedures[${i}]`, p.page, p.excerpt));
  return problems;
}

let failed = false;
for (const name of await listFixtures()) {
  const fx = await loadFixture(name); // validates expected.json / oracle.json against pages.md
  const out = new URL(fx.expected.document, fx.dir);
  if (!checkOnly) {
    if (fx.expected.scanned) await rasterise(fx, out);
    else await Deno.writeFile(out, await textPdf(fx.pages));
  }
  const problems = await check(fx);
  console.log(
    `${problems.length ? 'FAIL' : 'ok  '} ${name} (${fx.pages.length} pages${fx.expected.scanned ? ', scanned' : ''})`,
  );
  for (const p of problems) console.log(`     - ${p}`);
  failed ||= problems.length > 0;
}
console.log(`fixtures: ${FIXTURES_DIR.pathname}`);
if (failed) Deno.exit(1);
