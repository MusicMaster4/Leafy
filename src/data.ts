import { format, subDays } from 'date-fns'
import type { Transaction } from './types'

const at = (daysAgo: number) => format(subDays(new Date(), daysAgo), 'yyyy-MM-dd')

export const demoTransactions: Transaction[] = [
  { id: '1', type: 'income', amount: 7200, description: 'Salary', category: 'Salary', date: at(24) },
  { id: '2', type: 'expense', amount: 1850, description: 'Rent', category: 'Housing', date: at(23) },
  { id: '3', type: 'expense', amount: 148.9, description: 'Weekly groceries', category: 'Food', date: at(19) },
  { id: '4', type: 'expense', amount: 42, description: 'Uber', category: 'Transport', date: at(16) },
  { id: '5', type: 'income', amount: 850, description: 'Freelance project', category: 'Freelance', date: at(13) },
  { id: '6', type: 'expense', amount: 89.9, description: 'Internet', category: 'Subscriptions', date: at(10) },
  { id: '7', type: 'expense', amount: 32.5, description: 'Lunch', category: 'Food', date: at(7) },
  { id: '8', type: 'expense', amount: 210, description: 'Pharmacy', category: 'Health', date: at(5) },
  { id: '9', type: 'expense', amount: 76.8, description: 'Dinner with friends', category: 'Leisure', date: at(3) },
  { id: '10', type: 'expense', amount: 28, description: 'Coffee and snack', category: 'Food', date: at(0) },
]
