import { invoke } from '@tauri-apps/api/core'
import type { TransactionType } from './types'

const expenseRules: Array<[RegExp, string]> = [
  [/rent|mortgage|condo|electric|water|utility/i, 'Housing'],
  [/uber|taxi|fuel|gas station|bus|metro|parking/i, 'Transport'],
  [/market|grocery|restaurant|lunch|dinner|coffee|snack|food/i, 'Food'],
  [/pharmacy|doctor|dentist|hospital|medicine|gym/i, 'Health'],
  [/netflix|spotify|subscription|internet|phone plan/i, 'Subscriptions'],
  [/cinema|game|concert|bar|trip/i, 'Leisure'],
  [/store|amazon|clothes|shoes|mall/i, 'Shopping'],
]

const incomeRules: Array<[RegExp, string]> = [
  [/salary|paycheck|payroll/i, 'Salary'],
  [/freelance|client|project/i, 'Freelance'],
  [/dividend|interest|investment/i, 'Investments'],
  [/gift|present/i, 'Gift'],
]

export function localCategory(description: string, type: TransactionType) {
  const match = (type === 'expense' ? expenseRules : incomeRules).find(([pattern]) => pattern.test(description))
  return match?.[1] ?? 'Other'
}

export async function categorizeWithAi(description: string, type: TransactionType) {
  try {
    return await invoke<string>('categorize_transaction', { description, transactionType: type })
  } catch {
    return localCategory(description, type)
  }
}

export async function configureOpenRouter(key: string) {
  return invoke<void>('set_openrouter_key', { key })
}
