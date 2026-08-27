import { describe, expect, it } from 'vitest'
import { localCategory } from './ai'

describe('offline categorization', () => {
  it('recognizes common expenses', () => {
    expect(localCategory('Coffee shop', 'expense')).toBe('Food')
    expect(localCategory('Monthly Netflix', 'expense')).toBe('Subscriptions')
    expect(localCategory('Uber home', 'expense')).toBe('Transport')
  })

  it('falls back without blocking entry', () => {
    expect(localCategory('Something new', 'expense')).toBe('Other')
    expect(localCategory('Client project', 'income')).toBe('Freelance')
  })
})
