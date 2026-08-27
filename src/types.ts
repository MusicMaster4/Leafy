export type TransactionType = 'expense' | 'income'

export type Transaction = {
  id: string
  type: TransactionType
  amount: number
  description: string
  category: string
  date: string
}

export const expenseCategories = ['Alimentação', 'Moradia', 'Transporte', 'Lazer', 'Saúde', 'Compras', 'Assinaturas', 'Outros']
export const incomeCategories = ['Salário', 'Freelance', 'Investimentos', 'Presente', 'Outros']
