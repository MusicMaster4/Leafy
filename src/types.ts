export type TransactionType = 'expense' | 'income'

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
