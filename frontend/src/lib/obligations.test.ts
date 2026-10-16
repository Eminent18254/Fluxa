import { describe, expect, it } from 'vitest'
import {
  daysUntilDue,
  fromMinorUnits,
  formatMinorUnits,
  hasErrors,
  isOverdue,
  reviewState,
  toMinorUnits,
  toUnixSeconds,
  validateDraft,
  type Obligation,
} from './obligations'

/**
 * Money and validation are the two places a bug costs real money or wastes a
 * committee review, so they are the two places the pure logic is covered.
 */

describe('toMinorUnits', () => {
  it('converts a decimal amount to integer minor units', () => {
    expect(toMinorUnits('1250.00')).toBe('125000')
    expect(toMinorUnits('0.01')).toBe('1')
    expect(toMinorUnits('999')).toBe('99900')
  })

  it('pads a single decimal place', () => {
    expect(toMinorUnits('12.5')).toBe('1250')
  })

  it('drops leading zeros without losing the value', () => {
    expect(toMinorUnits('0.99')).toBe('99')
    expect(toMinorUnits('0000.10')).toBe('10')
  })

  it('rejects anything that is not a plain decimal number', () => {
    expect(() => toMinorUnits('')).toThrow()
    expect(() => toMinorUnits('abc')).toThrow()
    expect(() => toMinorUnits('1.2.3')).toThrow()
    expect(() => toMinorUnits('-5')).toThrow()
  })

  it('rejects more precision than the currency has', () => {
    expect(() => toMinorUnits('1.234')).toThrow(/decimal places/)
  })
})

describe('fromMinorUnits', () => {
  it('renders minor units back as a decimal string', () => {
    expect(fromMinorUnits('125000')).toBe('1250.00')
    expect(fromMinorUnits('1')).toBe('0.01')
    expect(fromMinorUnits('0')).toBe('0.00')
  })

  it('round-trips with toMinorUnits', () => {
    for (const value of ['0.01', '12.50', '1250.00', '99999.99']) {
      expect(fromMinorUnits(toMinorUnits(value))).toBe(Number(value).toFixed(2))
    }
  })
})

describe('formatMinorUnits', () => {
  it('formats as currency', () => {
    expect(formatMinorUnits('125000', 'USD')).toBe('$1,250.00')
  })

  it('falls back to a plain label for an unknown currency code', () => {
    expect(formatMinorUnits('100', 'ZZZ')).toContain('ZZZ')
  })
})

describe('toUnixSeconds', () => {
  it('converts a date input to unix seconds', () => {
    const seconds = Number(toUnixSeconds('2026-01-01'))
    expect(seconds).toBeGreaterThan(1_700_000_000)
    expect(Number.isInteger(seconds)).toBe(true)
  })

  it('rejects an unparseable date', () => {
    expect(() => toUnixSeconds('not-a-date')).toThrow()
  })
})

const validDraft = {
  externalId: 'INV-1',
  buyer: '0x1111111111111111111111111111111111111111',
  currency: 'USD',
  amount: '100.00',
  dueDate: '2026-12-01',
  evidenceUri: 'https://example.com/manifest.json',
  evidenceDigest: `sha256:${'a'.repeat(64)}`,
}

describe('validateDraft', () => {
  it('accepts a complete draft', () => {
    expect(hasErrors(validateDraft(validDraft))).toBe(false)
  })

  it('requires a buyer wallet address', () => {
    expect(validateDraft({ ...validDraft, buyer: '' }).buyer).toBeTruthy()
    expect(validateDraft({ ...validDraft, buyer: '0xnothex' }).buyer).toBeTruthy()
  })

  it('requires a three-letter currency code', () => {
    expect(validateDraft({ ...validDraft, currency: 'US' }).currency).toBeTruthy()
    expect(validateDraft({ ...validDraft, currency: 'US1' }).currency).toBeTruthy()
  })

  it('refuses a zero amount', () => {
    expect(validateDraft({ ...validDraft, amount: '0' }).amount).toBeTruthy()
  })

  it('requires an HTTPS manifest and a full SHA-256 digest', () => {
    expect(validateDraft({ ...validDraft, evidenceUri: 'http://example.com' }).evidenceUri).toBeTruthy()
    expect(validateDraft({ ...validDraft, evidenceDigest: 'md5:abc' }).evidenceDigest).toBeTruthy()
    expect(validateDraft({ ...validDraft, evidenceDigest: 'sha256:abc' }).evidenceDigest).toBeTruthy()
  })

  it('accepts a digest that pins the whole hash, whatever its case', () => {
    expect(validateDraft({ ...validDraft, evidenceDigest: `sha256:${'A1'.repeat(32)}` }).evidenceDigest).toBeUndefined()
  })

  it('reports every problem at once rather than one at a time', () => {
    const errors = validateDraft({ ...validDraft, buyer: '', currency: '', amount: '0', evidenceUri: '' })
    expect(Object.keys(errors).length).toBeGreaterThanOrEqual(4)
  })
})

const base: Obligation = {
  id: 'o1',
  externalId: 'INV-1',
  merchant: '0x2222222222222222222222222222222222222222',
  buyer: '0x1111111111111111111111111111111111111111',
  currency: 'USD',
  amountMinor: '125000',
  dueAt: '0',
  evidenceUri: 'https://example.com/manifest.json',
  evidenceDigest: 'sha256:abc',
  status: 'SUBMITTED',
  decision: 'NONE',
  confidenceBand: 'NONE',
  reason: '',
  inconsistencies: [],
  policyVersion: 'fluxa-obligation-v2',
  decisionRevision: 0,
  evidenceRevision: 1,
  evaluatedRevision: 0,
  contentDigest: '',
  verdictIsCurrent: false,
  paymentReference: '',
}

describe('due-date helpers', () => {
  const inDays = (days: number) => String(Math.floor((Date.now() + days * 86_400_000) / 1000))

  it('counts days until due', () => {
    expect(daysUntilDue({ ...base, dueAt: inDays(5) })).toBe(5)
  })

  it('reports overdue for a past due date', () => {
    expect(isOverdue({ ...base, dueAt: inDays(-2) })).toBe(true)
  })

  it('never reports a paid obligation as overdue', () => {
    expect(isOverdue({ ...base, dueAt: inDays(-2), status: 'PAID' })).toBe(false)
  })
})

/**
 * The contract judges each evidence revision once and refuses to reconsider a
 * verified obligation. These are the same rules the merchant panel renders from,
 * so they are checked here rather than only being trusted in the component.
 */
describe('reviewState', () => {
  it('allows the first judgement of a revision', () => {
    expect(reviewState({ ...base, status: 'SUBMITTED', evidenceRevision: 1, evaluatedRevision: 0 })).toEqual({
      judged: false,
      canVerify: true,
      canReplace: true,
    })
  })

  it('refuses to judge the revision that has already been ruled on', () => {
    const state = reviewState({ ...base, status: 'REJECTED', evidenceRevision: 1, evaluatedRevision: 1 })
    expect(state.judged).toBe(true)
    expect(state.canVerify).toBe(false)
  })

  it('allows a judgement again once a new revision has been committed', () => {
    const state = reviewState({ ...base, status: 'SUBMITTED', evidenceRevision: 2, evaluatedRevision: 1 })
    expect(state.judged).toBe(false)
    expect(state.canVerify).toBe(true)
  })

  it('treats a verified or paid obligation as finished', () => {
    for (const status of ['VERIFIED', 'PAID'] as const) {
      const state = reviewState({ ...base, status, evidenceRevision: 1, evaluatedRevision: 1 })
      expect(state.canVerify).toBe(false)
      expect(state.canReplace).toBe(false)
    }
  })

  it('stops replacing once the evidence revisions are used up', () => {
    const state = reviewState({ ...base, status: 'REJECTED', evidenceRevision: 3, evaluatedRevision: 3 })
    expect(state.canReplace).toBe(false)
    expect(state.canVerify).toBe(false)
  })
})
