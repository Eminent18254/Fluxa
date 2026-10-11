/**
 * The obligation domain model, mirrored from the Intelligent Contract.
 *
 * Statuses here are the contract's own bounded enums. They are deliberately not
 * softened into generic invoice states: a screen that says "open" when the
 * contract says MORE_EVIDENCE_REQUIRED is lying to the merchant about the one
 * thing they need to act on.
 */

export const OBLIGATION_STATUSES = [
  'SUBMITTED',
  'VERIFIED',
  'REJECTED',
  'MORE_EVIDENCE_REQUIRED',
  'PAID',
] as const;

export type ObligationStatus = (typeof OBLIGATION_STATUSES)[number];

export const DECISIONS = ['VERIFIED', 'REJECTED', 'MORE_EVIDENCE_REQUIRED'] as const;
export type Decision = (typeof DECISIONS)[number];

export const CONFIDENCE_BANDS = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number];

/** Shape returned by the contract's serializers. */
export type Obligation = {
  id: string;
  externalId: string;
  merchant: string;
  buyer: string;
  currency: string;
  amountMinor: string;
  dueAt: string;
  evidenceUri: string;
  evidenceDigest: string;
  status: ObligationStatus;
  decision: Decision | 'NONE';
  confidenceBand: ConfidenceBand | 'NONE';
  reason: string;
  inconsistencies: string[];
  policyVersion: string;
  decisionRevision: number;
  evidenceRevision: number;
  paymentReference: string;
};

export type ObligationDraft = {
  externalId: string;
  buyer: string;
  currency: string;
  amount: string;
  dueDate: string;
  evidenceUri: string;
  evidenceDigest: string;
  evidence: string;
};

export type DraftErrors = Partial<Record<keyof ObligationDraft, string>>;

export const MAX_EXTERNAL_ID_CHARS = 120;
export const MAX_EVIDENCE_CHARS = 20000;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** `1234.56` -> `"123456"` for a 2-decimal currency, rounding half up. */
export function toMinorUnits(value: string, exponent = 2): string {
  const cleaned = String(value).trim().replace(/,/g, '');
  if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === '' || cleaned === '.') {
    throw new Error('Enter an amount like 1250.00');
  }
  const [whole, fraction = ''] = cleaned.split('.');
  if (fraction.length > exponent) {
    throw new Error(`Use at most ${exponent} decimal places`);
  }
  const padded = fraction.padEnd(exponent, '0');
  const combined = `${whole || '0'}${padded}`.replace(/^0+(?=\d)/, '');
  return combined === '' ? '0' : combined;
}

/** Minor units -> a plain decimal string for display. */
export function fromMinorUnits(value: string, exponent = 2): string {
  const digits = String(value).replace(/\D/g, '') || '0';
  const padded = digits.padStart(exponent + 1, '0');
  const whole = padded.slice(0, padded.length - exponent) || '0';
  const fraction = padded.slice(padded.length - exponent);
  return exponent === 0 ? whole : `${whole}.${fraction}`;
}

export function formatMinorUnits(value: string, currency = 'USD', exponent = 2): string {
  const numeric = Number(fromMinorUnits(value, exponent));
  try {
    return numeric.toLocaleString('en-US', { style: 'currency', currency, minimumFractionDigits: exponent })
  } catch {
    return `${numeric.toLocaleString('en-US', { minimumFractionDigits: exponent })} ${currency}`
  }
}

/** A due date is stored as unix seconds; the date input works in local days. */
export function toUnixSeconds(date: string): string {
  const parsed = new Date(`${date}T23:59:59`)
  if (Number.isNaN(parsed.getTime())) throw new Error('Enter a valid due date')
  return String(Math.floor(parsed.getTime() / 1000))
}

export function defaultDueDate(days = 14): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}

export function formatDueDate(unixSeconds: string): string {
  const ms = Number(unixSeconds) * 1000
  if (!Number.isFinite(ms) || ms <= 0) return '-'
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function isOverdue(obligation: Obligation): boolean {
  if (obligation.status === 'PAID') return false
  return Number(obligation.dueAt) * 1000 < Date.now()
}

/** Days until due, negative once past due. */
export function daysUntilDue(obligation: Obligation): number {
  const ms = Number(obligation.dueAt) * 1000
  return Math.round((ms - Date.now()) / 86_400_000)
}

/** Client-side checks that mirror the contract's own validation. */
export function validateDraft(draft: ObligationDraft): DraftErrors {
  const errors: DraftErrors = {}

  const externalId = draft.externalId.trim()
  if (!externalId) errors.externalId = 'Add a reference for this obligation.'
  else if (externalId.length > MAX_EXTERNAL_ID_CHARS) errors.externalId = `Keep the reference under ${MAX_EXTERNAL_ID_CHARS} characters.`

  const buyer = draft.buyer.trim()
  if (!buyer) errors.buyer = 'The buyer wallet is who can record payment.'
  else if (!ADDRESS_PATTERN.test(buyer)) errors.buyer = 'Enter a 0x wallet address.'

  const currency = draft.currency.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) errors.currency = 'Use a three-letter currency code, like USD.'

  try {
    if (toMinorUnits(draft.amount) === '0') errors.amount = 'The amount must be greater than zero.'
  } catch (cause) {
    errors.amount = cause instanceof Error ? cause.message : 'Enter a valid amount.'
  }

  if (!draft.dueDate) errors.dueDate = 'Choose a due date.'

  const uri = draft.evidenceUri.trim()
  if (!uri) errors.evidenceUri = 'Point at the evidence manifest.'
  else if (!uri.startsWith('https://')) errors.evidenceUri = 'The manifest must be an HTTPS URL.'

  const digest = draft.evidenceDigest.trim()
  if (!digest) errors.evidenceDigest = 'Add the SHA-256 digest of the evidence.'
  else if (!digest.startsWith('sha256:')) errors.evidenceDigest = 'The digest must start with sha256:.'

  const evidence = draft.evidence.trim()
  if (!evidence) errors.evidence = 'Paste the evidence the committee should read.'
  else if (evidence.length > MAX_EVIDENCE_CHARS) errors.evidence = `Keep the evidence under ${MAX_EVIDENCE_CHARS} characters.`

  return errors
}

export function hasErrors(errors: DraftErrors): boolean {
  return Object.keys(errors).length > 0
}
