import { eachDayOfInterval, format, isAfter, parseISO, startOfDay, subDays } from 'date-fns'
import { currencyDetails, type CurrencyCode, type Transaction } from './types'

export const money = (value: number, compact = false, currency: CurrencyCode = 'BRL') => {
  const details = currencyDetails(currency)
  return new Intl.NumberFormat(details.locale, {
    style: 'currency', currency,
    notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: compact ? 1 : 2,
  }).format(value)
}

export function parseAmount(input: string) {
  const clean = input.trim().replace(/[^\d.,-]/g, '')
  const comma = clean.lastIndexOf(',')
  const dot = clean.lastIndexOf('.')
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? ',' : '.'
    const thousands = decimal === ',' ? /\./g : /,/g
    return Number(clean.replace(thousands, '').replace(decimal, '.'))
  }
  if (comma >= 0) return Number(clean.replace(/\./g, '').replace(',', '.'))
  return Number(clean)
}

export function summarize(transactions: Transaction[]) {
  const income = transactions.filter(t => t.type === 'income').reduce((sum, t) => sum + t.amount, 0)
  const expenses = transactions.filter(t => t.type === 'expense').reduce((sum, t) => sum + t.amount, 0)
  return { income, expenses, balance: income - expenses, savingsRate: income ? ((income - expenses) / income) * 100 : 0 }
}

export function lastDays(transactions: Transaction[], days: number) {
  const start = startOfDay(subDays(new Date(), days - 1))
  return transactions.filter(t => !isAfter(start, parseISO(t.date)))
}

export function dailySeries(transactions: Transaction[], days = 30) {
  const start = startOfDay(subDays(new Date(), days - 1))
  const interval = eachDayOfInterval({ start, end: new Date() })
  return interval.map(day => {
    const key = format(day, 'yyyy-MM-dd')
    const daily = transactions.filter(t => t.date === key)
    return {
      date: format(day, 'dd/MM'),
      income: daily.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0),
      expenses: daily.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0),
    }
  })
}

export function cumulativeBalanceSeries(transactions: Transaction[]) {
  const dailyChanges = new Map<string, number>()
  transactions.forEach(transaction => {
    const change = transaction.type === 'income' ? transaction.amount : -transaction.amount
    dailyChanges.set(transaction.date, (dailyChanges.get(transaction.date) || 0) + change)
  })

  let balance = 0
  return [...dailyChanges.entries()]
    .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
    .map(([date, change]) => {
      balance += change
      return { date, balance }
    })
}

export function balanceZeroOffset(series: Array<{ balance: number }>) {
  const range = series.reduce((current, point) => ({
    min: Math.min(current.min, point.balance),
    max: Math.max(current.max, point.balance),
  }), { min: 0, max: 0 })
  return range.max === range.min ? 50 : (range.max / (range.max - range.min)) * 100
}

export function categorySeries(transactions: Transaction[]) {
  const grouped = new Map<string, number>()
  transactions.filter(t => t.type === 'expense').forEach(t => grouped.set(t.category, (grouped.get(t.category) || 0) + t.amount))
  return [...grouped.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value)
}
