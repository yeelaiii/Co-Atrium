// Text per page, cheapest method first: the PDF text layer (unpdf), DOCX raw text (mammoth,
// page breaks estimated), and single-page PDFs for OCR (pdf-lib).

import mammoth from 'mammoth';
import { PDFDocument } from 'pdf-lib';
import { extractText, getDocumentProxy } from 'unpdf';

/** One string per page from the PDF text layer ('' for pages without one). */
export async function pdfPages(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes)); // copy: pdf.js may detach the buffer
  const { text } = await extractText(pdf, { mergePages: false });
  return (Array.isArray(text) ? text : [text]).map((t) => t.replaceAll('\u0000', '').trim());
}

export const DOCX_CHARS_PER_PAGE = 3_000;

/**
 * DOCX raw text split into estimated pages of ~3,000 characters at paragraph boundaries.
 * DOCX files don't store pagination, so these page numbers are estimates (flagged in the UI).
 */
export async function docxPages(bytes: Uint8Array): Promise<string[]> {
  const { value } = await mammoth.extractRawText({ buffer: bytesToBuffer(bytes) });
  return splitIntoPages(value, DOCX_CHARS_PER_PAGE);
}

export function splitIntoPages(text: string, perPage: number): string[] {
  const paras = text.replace(/\r/g, '').split(/\n{2,}|\n(?=\s*\S)/).map((p) => p.trim()).filter(Boolean);
  const pages: string[] = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length + 1 > perPage) {
      pages.push(cur);
      cur = '';
    }
    // A single paragraph longer than a page is cut at a space.
    let rest = p;
    while (rest.length > perPage) {
      const cut = rest.lastIndexOf(' ', perPage) > perPage / 2 ? rest.lastIndexOf(' ', perPage) : perPage;
      if (cur) {
        pages.push(cur);
        cur = '';
      }
      pages.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    cur = cur ? `${cur}\n${rest}` : rest;
  }
  if (cur) pages.push(cur);
  return pages.length ? pages : [''];
}

/** A new PDF containing only page `pageNo` (1-based) of `bytes`. */
export async function singlePagePdf(bytes: Uint8Array, pageNo: number): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const [page] = await out.copyPages(src, [pageNo - 1]);
  out.addPage(page);
  return await out.save();
}

// mammoth's Node build wants a Buffer.
function bytesToBuffer(bytes: Uint8Array) {
  // deno-lint-ignore no-explicit-any
  const B = (globalThis as any).Buffer;
  return B ? B.from(bytes) : bytes;
}
