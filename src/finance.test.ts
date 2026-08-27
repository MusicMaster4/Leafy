import { describe, expect, it } from 'vitest'
import { categorySeries, summarize } from './finance'
import type { Transaction } from './types'

const rows: Transaction[] = [
  { id: '1', type: 'income', amount: 1000, description: '', category: 'Salário', date: '2025-01-01' },
  { id: '2', type: 'expense', amount: 200, description: '', category: 'Moradia', date: '2025-01-02' },
  { id: '3', type: 'expense', amount: 50, description: '', category: 'Moradia', date: '2025-01-03' },
]

describe('finance helpers', () => {
  it('summarizes balance and savings', () => expect(summarize(rows)).toEqual({ income: 1000, expenses: 250, balance: 750, savingsRate: 75 }))
  it('groups expenses by category', () => expect(categorySeries(rows)).toEqual([{ name: 'Moradia', value: 250 }]))
})
