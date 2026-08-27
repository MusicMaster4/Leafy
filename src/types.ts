export type TransactionType = 'expense' | 'income'

export const currencies = [
  { code: 'BRL', label: 'Brazilian Real', symbol: 'R$', locale: 'pt-BR' },
  { code: 'USD', label: 'US Dollar', symbol: '$', locale: 'en-US' },
  { code: 'EUR', label: 'Euro', symbol: '€', locale: 'en-IE' },
  { code: 'GBP', label: 'British Pound', symbol: '£', locale: 'en-GB' },
] as const

export type CurrencyCode = typeof currencies[number]['code']

export const isCurrencyCode = (value: unknown): value is CurrencyCode =>
  typeof value === 'string' && currencies.some(currency => currency.code === value)

export const currencyDetails = (code: CurrencyCode) => currencies.find(currency => currency.code === code) ?? currencies[0]

export type Transaction = {
  id: string
  type: TransactionType
  amount: number
  description: string
  category: string
  date: string
}

export const expenseCategories = ['Food', 'Housing', 'Transport', 'Leisure', 'Health', 'Shopping', 'Subscriptions', 'Other']
export const incomeCategories = ['Salary', 'Freelance', 'Investments', 'Gift', 'Other']
