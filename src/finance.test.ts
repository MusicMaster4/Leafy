import { describe, expect, it } from 'vitest'
import { balanceZeroOffset, categorySeries, cumulativeBalanceSeries, money, parseAmount, summarize } from './finance'
import type { Transaction } from './types'

const rows: Transaction[] = [
  { id: '1', type: 'income', amount: 1000, description: '', category: 'Salary', date: '2025-01-01' },
  { id: '2', type: 'expense', amount: 200, description: '', category: 'Housing', date: '2025-01-02' },
  { id: '3', type: 'expense', amount: 50, description: '', category: 'Housing', date: '2025-01-03' },
]

describe('finance helpers', () => {
  it('summarizes balance and savings', () => expect(summarize(rows)).toEqual({ income: 1000, expenses: 250, balance: 750, savingsRate: 75 }))
  it('groups expenses by category', () => expect(categorySeries(rows)).toEqual([{ name: 'Housing', value: 250 }]))
  it('builds an all-time cumulative balance grouped by date', () => {
    const unorderedRows: Transaction[] = [
      rows[2],
      { id: '4', type: 'expense', amount: 100, description: '', category: 'Other', date: '2025-01-01' },
      rows[0],
      rows[1],
    ]

    expect(cumulativeBalanceSeries(unorderedRows)).toEqual([
      { date: '2025-01-01', balance: 900 },
      { date: '2025-01-02', balance: 700 },
      { date: '2025-01-03', balance: 650 },
    ])
  })
  it('positions the balance color change at zero', () => {
    expect(balanceZeroOffset([{ balance: -300 }, { balance: 100 }])).toBe(25)
    expect(balanceZeroOffset([{ balance: 100 }, { balance: 300 }])).toBe(100)
    expect(balanceZeroOffset([{ balance: -300 }, { balance: -100 }])).toBe(0)
  })
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
