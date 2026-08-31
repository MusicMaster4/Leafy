import { addMonths, format, getDaysInMonth, parseISO, startOfDay } from 'date-fns'
import type { RecurringExpense, Transaction } from './types'

const dateKey = (date: Date) => format(date, 'yyyy-MM-dd')

function occurrenceInMonth(date: Date, dayOfMonth: number) {
  const occurrence = new Date(date.getFullYear(), date.getMonth(), Math.min(dayOfMonth, getDaysInMonth(date)))
  return dateKey(occurrence)
}

export function nextMonthlyOccurrence(dayOfMonth: number, from = new Date()) {
  const day = Math.max(1, Math.min(31, Math.trunc(dayOfMonth)))
  const today = dateKey(startOfDay(from))
  const thisMonth = occurrenceInMonth(from, day)
  return thisMonth >= today ? thisMonth : occurrenceInMonth(addMonths(from, 1), day)
}

export function nextRecurringDueDate(rule: RecurringExpense) {
  if (!rule.lastGeneratedDate) return rule.startDate
  return occurrenceInMonth(addMonths(parseISO(rule.lastGeneratedDate), 1), rule.dayOfMonth)
}

export function materializeRecurringExpenses(
  rules: RecurringExpense[],
  existingTransactions: Transaction[],
  through = new Date(),
) {
  const throughDate = dateKey(startOfDay(through))
  const existingIds = new Set(existingTransactions.map(row => row.id))
  const transactions: Transaction[] = []
  let changed = false

  const updatedRules = rules.map(rule => {
    let dueDate = nextRecurringDueDate(rule)
    let lastGeneratedDate = rule.lastGeneratedDate
    let generatedMonths = 0

    while (dueDate <= throughDate && generatedMonths < 1200) {
      const id = `recurring:${rule.id}:${dueDate}`
      if (!existingIds.has(id)) {
        transactions.push({
          id,
          type: 'expense',
          amount: rule.amount,
          description: rule.description,
          category: rule.category,
          date: dueDate,
          recurringExpenseId: rule.id,
        })
        existingIds.add(id)
      }
      lastGeneratedDate = dueDate
      dueDate = occurrenceInMonth(addMonths(parseISO(dueDate), 1), rule.dayOfMonth)
      generatedMonths += 1
    }

    if (lastGeneratedDate !== rule.lastGeneratedDate) {
      changed = true
      return { ...rule, lastGeneratedDate }
    }
    return rule
  })

  return { transactions, rules: changed ? updatedRules : rules }
}
