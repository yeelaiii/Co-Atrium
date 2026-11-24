// Section classification: heading and keyword rules first, carried forward until the next
// heading; only pages the rules can't place go to the `classify` LLM task. Pure.
//
// Which sections each task may read is decided here (TASK_SECTIONS) and nowhere else:
// general conditions, specifications, BQ and drawing lists are never sent for extraction.

export const SECTIONS = [
  'articles',
  'general_conditions',
  'appendix',
  'particular_conditions',
  'preliminaries',
  'specifications',
  'drawings_list',
  'bq',
  'supplementary_agreement',
  'other',
] as const;
export type Section = (typeof SECTIONS)[number];

export const SECTION_LABEL: Record<Section, string> = {
  articles: 'Articles of agreement',
  general_conditions: 'General conditions',
  appendix: 'Appendix',
  particular_conditions: 'Particular / special conditions',
  preliminaries: 'Preliminaries',
  specifications: 'Specifications',
  drawings_list: 'Drawings list',
  bq: 'Bills of quantities',
  supplementary_agreement: 'Supplementary agreement',
  other: 'Other',
};

/** Sections each LLM task may receive. Enforced by pagesForTask(); tested. */
export const TASK_SECTIONS = {
  identify_contract: ['articles', 'appendix', 'supplementary_agreement'],
  extract_fields: ['articles', 'appendix', 'particular_conditions', 'supplementary_agreement'],
  extract_amendments: ['particular_conditions', 'supplementary_agreement'],
  extract_procedures: ['preliminaries'],
} as const satisfies Record<string, readonly Section[]>;

export type ExtractionTask = keyof typeof TASK_SECTIONS;

/** Never sent to any extraction task. */
export const NEVER_EXTRACTED: readonly Section[] = ['general_conditions', 'specifications', 'bq', 'drawings_list'];

export interface PageLike {
  page_no: number;
  text: string;
  section: Section | null;
}

export function pagesForTask<P extends PageLike>(task: ExtractionTask, pages: readonly P[]): P[] {
  const allowed = new Set<Section>(TASK_SECTIONS[task]);
  return pages.filter((p) =>
    p.section !== null && allowed.has(p.section) && !NEVER_EXTRACTED.includes(p.section) && p.text.trim() !== ''
  );
}

// Heading rules, most specific first ("Particular Conditions of Contract" before "Conditions of Contract").
const RULES: readonly [Section, RegExp][] = [
  [
    'supplementary_agreement',
    /\b(supplementary\s+agreement|deed\s+of\s+variation|addendum\s+(no\.?|to\s+the\s+contract))\b/i,
  ],
  [
    'particular_conditions',
    /\b(particular|special)\s+conditions\b|\bamendments?\s+to\s+the\s+(general\s+)?conditions\b/i,
  ],
  [
    'appendix',
    /^\s*(the\s+)?appendix\b|\bappendix\s+to\s+the\s+(general\s+)?conditions\b|\bschedule\s+of\s+(contract\s+)?particulars\b|\bcontract\s+data\b/i,
  ],
  [
    'articles',
    /\barticles\s+of\s+agreement\b|\bform\s+of\s+(agreement|contract)\b|\bthis\s+agreement\s+is\s+made\b|\bnow\s+it\s+is\s+(hereby\s+)?agreed\b/i,
  ],
  ['preliminaries', /\bpreliminaries\b|\bgeneral\s+requirements\b/i],
  ['bq', /\bbills?\s+of\s+quantities\b|\bschedule\s+of\s+rates\b|\bpricing\s+schedule\b/i],
  ['drawings_list', /\b(list|schedule|register)\s+of\s+drawings\b|\bdrawings?\s+(list|register|schedule)\b/i],
  ['specifications', /^\s*(technical\s+|particular\s+|general\s+)?specifications?\b/i],
  ['general_conditions', /\b(general\s+)?conditions\s+of\s+(contract|sub-?contract)\b|^\s*general\s+conditions\b/i],
];

/** The section a page's heading lines announce, or null. Looks at the first non-empty lines only. */
export function headingSection(text: string, lines = 6): Section | null {
  const head = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, lines);
  for (const line of head) {
    if (line.length > 160) continue; // body text, not a heading
    for (const [section, re] of RULES) if (re.test(line)) return section;
  }
  return null;
}

export interface Classified {
  page_no: number;
  section: Section | null;
  source: 'rule' | null;
}

/**
 * Rule pass over pages in order. A heading sets the section for that page and the following
 * pages until the next heading. Pages before the first heading (and pages without text) stay
 * null: those go to the LLM classifier.
 */
export function classifyByRules(pages: readonly { page_no: number; text: string }[]): Classified[] {
  let current: Section | null = null;
  return [...pages].sort((a, b) => a.page_no - b.page_no).map((p) => {
    if (!p.text.trim()) return { page_no: p.page_no, section: null, source: null };
    const h = headingSection(p.text);
    if (h) current = h;
    return { page_no: p.page_no, section: current, source: current ? 'rule' : null };
  });
}

/** Short excerpt for the classifier: the start of the page, at most `max` characters. */
export function pageExcerpt(text: string, max = 600): string {
  const t = text.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}
