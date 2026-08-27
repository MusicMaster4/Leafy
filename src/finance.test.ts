import { describe, expect, it } from 'vitest'
import { categorySeries, money, parseAmount, summarize } from './finance'
import type { Transaction } from './types'

const rows: Transaction[] = [
  { id: '1', type: 'income', amount: 1000, description: '', category: 'Salary', date: '2025-01-01' },
  { id: '2', type: 'expense', amount: 200, description: '', category: 'Housing', date: '2025-01-02' },
  { id: '3', type: 'expense', amount: 50, description: '', category: 'Housing', date: '2025-01-03' },
]

describe('finance helpers', () => {
  it('summarizes balance and savings', () => expect(summarize(rows)).toEqual({ income: 1000, expenses: 250, balance: 750, savingsRate: 75 }))
  it('groups expenses by category', () => expect(categorySeries(rows)).toEqual([{ name: 'Housing', value: 250 }]))
  it('accepts dot and comma decimal input', () => {
    expect(parseAmount('24.90')).toBe(24.9)
    expect(parseAmount('24,90')).toBe(24.9)
    expect(parseAmount('1,234.56')).toBe(1234.56)
    expect(parseAmount('1.234,56')).toBe(1234.56)
  })
  it('uses Brazilian real by default and supports a selected currency', () => {
    expect(money(1234.56)).toContain('1.234,56')
    expect(money(1234.56, false, 'USD')).toBe('$1,234.56')
  })
})
