// Client side of the VO contractual layer (migration 0023): formatting, RPC wrappers and the
// register export. Lifecycle rules and contract-sum maths come from @shared/contracts/variations.

import {
  contractSum,
  currentAmount,
  VO_SOURCE_LABEL,
  VO_STATUS_LABEL,
  type ContractSum,
  type VoContractStatus,
} from '@shared/contracts/variations.ts';
import { File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

import { DISCLAIMER, PARTY_LABEL } from '@/lib/deadlines';
import { supabase } from '@/lib/supabase';
import { voCode, type VariationOrder } from '@/lib/variation-orders';

export { VO_SOURCE_LABEL, VO_STATUS_LABEL };

/** What the VO contract update screen does (route param). */
export type VoAction = 'quotation' | 'valuation' | 'instruction' | 'confirmation' | 'objection' | 'agree' | 'status' | 'amounts';

/** "SGD 12,000.00"; omissions and other negatives get a minus sign. */
export function formatMoney(n: number | null, currency = 'SGD'): string {
  if (n === null) return '—';
  const abs = Math.abs(n).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '−' : ''}${currency} ${abs}`;
}

/** Parses "12,000.50" -> 12000.5. Empty -> null. Invalid -> NaN. */
export function parseAmount(text: string): number | null {
  const t = text.replace(/[,\s]/g, '').replace(/^SGD/i, '');
  if (!t) return null;
  return /^\d{1,12}(\.\d{1,2})?$/.test(t) ? Number(t) : NaN;
}

export const daysText = (d: number | null) => (d === null ? '—' : `${d} day${d === 1 ? '' : 's'}`);

export const voAmounts = (vo: VariationOrder) => ({
  status: vo.contract.status,
  claimed: vo.contract.claimed,
  assessed: vo.contract.assessed,
  agreed: vo.contract.agreed,
  isOmission: vo.contract.isOmission,
});

/** Totals over the VOs this person can see (the register). */
export const registerTotals = (vos: VariationOrder[], original: number | null): ContractSum =>
  contractSum(original, vos.map(voAmounts));

export const voCurrentAmount = (vo: VariationOrder) => currentAmount(voAmounts(vo));

/** Server totals over every VO in the project, including ones not shared with you. Contract roles only. */
export type ProjectContractSum = {
  currency: string;
  original: number | null;
  agreed: number;
  pending: number;
  disputed: number;
  revised: number | null;
  revised_incl_pending: number | null;
  vo_count: number;
  unpriced_count: number;
};

export async function fetchProjectContractSum(projectId: string): Promise<ProjectContractSum | null> {
  const { data, error } = await supabase.rpc('project_contract_sum', { pid: projectId });
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  if (error || !row) return null;
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    currency: String(row.currency ?? 'SGD'),
    original: n(row.original),
    agreed: n(row.agreed) ?? 0,
    pending: n(row.pending) ?? 0,
    disputed: n(row.disputed) ?? 0,
    revised: n(row.revised),
    revised_incl_pending: n(row.revised_incl_pending),
    vo_count: Number(row.vo_count ?? 0),
    unpriced_count: Number(row.unpriced_count ?? 0),
  };
}

export type VoHistoryEntry = {
  id: number;
  field: string;
  old_value: unknown;
  new_value: unknown;
  source_event_id: string | null;
  note: string | null;
  changed_by: string | null;
  changed_at: string;
  changer: { display_name: string | null } | null;
};

export const HISTORY_FIELD_LABEL: Record<string, string> = {
  contract_status: 'Status',
  claimed_amount: 'Claimed',
  assessed_amount: 'Assessed',
  agreed_amount: 'Agreed',
  is_omission: 'Omission',
  time_impact_days_claimed: 'Time claimed',
  time_impact_days_agreed: 'Time agreed',
};

export function historyValue(field: string, v: unknown, currency = 'SGD'): string {
  if (v === null || v === undefined) return '—';
  if (field === 'contract_status') return VO_STATUS_LABEL[v as VoContractStatus] ?? String(v);
  if (field === 'is_omission') return v ? 'Yes' : 'No';
  if (field.startsWith('time_')) return daysText(Number(v));
  return formatMoney(Number(v), currency);
}

// ---------------------------------------------------------------------
// Export (CSV and PDF through the share sheet)
// ---------------------------------------------------------------------

export type RegisterRow = { vo: VariationOrder; paymentClaims: string[] };

/** A text cell safe for spreadsheets: quoted when needed, and never read as a formula. */
function csvText(v: string | null): string {
  let s = v ?? '';
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvNum = (n: number | null) => (n === null ? '' : n.toFixed(2));

export function registerCsv(rows: RegisterRow[]): string {
  const head = ['VO', 'Title', 'Status', 'Source', 'Instructing party', 'Instruction ref', 'Omission', 'Claimed', 'Assessed',
    'Agreed', 'Current (signed)', 'Time claimed (days)', 'Time agreed (days)', 'Status since', 'Payment claims'];
  const lines = rows.map(({ vo, paymentClaims }) => {
    const c = vo.contract;
    return [
      csvText(voCode(vo)),
      csvText(vo.name),
      csvText(VO_STATUS_LABEL[c.status]),
      csvText(c.source ? VO_SOURCE_LABEL[c.source] : null),
      csvText(c.instructingParty ? PARTY_LABEL[c.instructingParty] : null),
      csvText(c.instructionReference),
      c.isOmission ? 'Yes' : 'No',
      csvNum(c.claimed),
      csvNum(c.assessed),
      csvNum(c.agreed),
      csvNum(voCurrentAmount(vo)),
      c.timeClaimed ?? '',
      c.timeAgreed ?? '',
      c.statusAt.slice(0, 10),
      csvText(paymentClaims.join('; ')),
    ].join(',');
  });
  // BOM so Excel reads UTF-8 (the minus sign, names).
  return `﻿${[head.join(','), ...lines].join('\r\n')}\r\n`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function registerHtml(opts: { projectName: string; rows: RegisterRow[]; totals: ContractSum; currency: string; filterNote: string }): string {
  const { rows, totals, currency } = opts;
  const m = (n: number | null) => esc(formatMoney(n, currency));
  const body = rows
    .map(({ vo, paymentClaims }) => {
      const c = vo.contract;
      return `<tr><td>${esc(voCode(vo))}</td><td>${esc(vo.name)}${c.instructionReference ? `<br><small>${esc(c.instructionReference)}</small>` : ''}</td>
        <td>${esc(VO_STATUS_LABEL[c.status])}${c.isOmission ? '<br><small>Omission</small>' : ''}</td>
        <td class="n">${m(c.claimed)}</td><td class="n">${m(c.assessed)}</td><td class="n">${m(c.agreed)}</td>
        <td class="n">${esc(daysText(c.timeClaimed))}</td><td class="n">${esc(daysText(c.timeAgreed))}</td>
        <td>${esc(paymentClaims.join(', ') || '—')}</td></tr>`;
    })
    .join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @page { margin: 16mm; }
    body { font-family: -apple-system, Roboto, sans-serif; color: #14262B; font-size: 10px; }
    h1 { font-size: 16px; margin: 0 0 2px; } p { margin: 2px 0; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th, td { border-bottom: 1px solid #DDD8CC; padding: 4px; text-align: left; vertical-align: top; }
    th { font-weight: 600; } .n { text-align: right; white-space: nowrap; } small { color: #4A5B60; }
    .totals td { border: none; padding: 1px 8px 1px 0; }
  </style></head><body>
    <h1>Variation order register: ${esc(opts.projectName)}</h1>
    <p><small>${esc(opts.filterNote)} · generated ${esc(new Date().toLocaleString('en-SG'))}</small></p>
    <table class="totals">
      <tr><td>Agreed</td><td class="n">${m(totals.agreed)}</td></tr>
      <tr><td>Pending (assessed, else claimed)</td><td class="n">${m(totals.pending)}</td></tr>
      <tr><td>Disputed</td><td class="n">${m(totals.disputed)}</td></tr>
      ${totals.unpriced ? `<tr><td colspan="2"><small>${totals.unpriced} VO(s) without an amount are not in these totals.</small></td></tr>` : ''}
    </table>
    <table><thead><tr><th>VO</th><th>Title</th><th>Status</th><th class="n">Claimed</th><th class="n">Assessed</th>
      <th class="n">Agreed</th><th class="n">Time claimed</th><th class="n">Time agreed</th><th>Payment claims</th></tr></thead>
      <tbody>${body}</tbody></table>
    <p style="margin-top:12px"><small>${esc(DISCLAIMER)}</small></p>
  </body></html>`;
}

export async function shareCsv(csv: string, fileName: string) {
  const file = new File(Paths.cache, fileName);
  file.create({ overwrite: true });
  await file.write(csv);
  await Sharing.shareAsync(file.uri, { mimeType: 'text/csv', UTI: 'public.comma-separated-values-text', dialogTitle: 'Export VO register' });
}

export async function sharePdf(html: string) {
  // A4 landscape at 72 points per inch.
  const { uri } = await Print.printToFileAsync({ html, width: 842, height: 595 });
  await Sharing.shareAsync(uri, { mimeType: 'application/pdf', UTI: '.pdf', dialogTitle: 'Export VO register' });
}

export const canShare = () => Sharing.isAvailableAsync();
