import { describe, expect, it } from 'vitest'
import { materializeRecurringExpenses, nextMonthlyOccurrence, nextRecurringDueDate } from './recurring'
import type { RecurringExpense } from './types'

const rule = (overrides: Partial<RecurringExpense> = {}): RecurringExpense => ({
  id: 'rent',
  amount: 1500,
  description: 'Rent',
  category: 'Housing',
  dayOfMonth: 10,
  startDate: '2026-01-10',
  ...overrides,
})

describe('monthly recurring expenses', () => {
  it('starts on the next selected day, including today', () => {
    expect(nextMonthlyOccurrence(27, new Date(2026, 7, 27))).toBe('2026-08-27')
    expect(nextMonthlyOccurrence(10, new Date(2026, 7, 27))).toBe('2026-09-10')
  })

  it('uses the final day in shorter months', () => {
    expect(nextMonthlyOccurrence(31, new Date(2027, 1, 27))).toBe('2027-02-28')
    expect(nextMonthlyOccurrence(31, new Date(2028, 1, 27))).toBe('2028-02-29')
  })

  it('creates every due occurrence after the app was closed', () => {
    const result = materializeRecurringExpenses([rule()], [], new Date(2026, 2, 12))
    expect(result.transactions.map(row => row.date)).toEqual(['2026-01-10', '2026-02-10', '2026-03-10'])
    expect(result.transactions.every(row => row.recurringExpenseId === 'rent')).toBe(true)
    expect(result.rules[0].lastGeneratedDate).toBe('2026-03-10')
    expect(nextRecurringDueDate(result.rules[0])).toBe('2026-04-10')
  })

  it('does not duplicate an occurrence and advances it after a deleted entry', () => {
    const january = materializeRecurringExpenses([rule()], [], new Date(2026, 0, 10))
    const repeated = materializeRecurringExpenses(january.rules, january.transactions, new Date(2026, 0, 10))
    expect(repeated.transactions).toEqual([])

    const afterDeletion = materializeRecurringExpenses(january.rules, [], new Date(2026, 0, 10))
    expect(afterDeletion.transactions).toEqual([])
  })
})
