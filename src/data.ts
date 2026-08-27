import { format, subDays } from 'date-fns'
import type { Transaction } from './types'

const at = (daysAgo: number) => format(subDays(new Date(), daysAgo), 'yyyy-MM-dd')

export const demoTransactions: Transaction[] = [
  { id: '1', type: 'income', amount: 7200, description: 'Salário', category: 'Salário', date: at(24) },
  { id: '2', type: 'expense', amount: 1850, description: 'Aluguel', category: 'Moradia', date: at(23) },
  { id: '3', type: 'expense', amount: 148.9, description: 'Mercado da semana', category: 'Alimentação', date: at(19) },
  { id: '4', type: 'expense', amount: 42, description: 'Uber', category: 'Transporte', date: at(16) },
  { id: '5', type: 'income', amount: 850, description: 'Projeto freelance', category: 'Freelance', date: at(13) },
  { id: '6', type: 'expense', amount: 89.9, description: 'Internet', category: 'Assinaturas', date: at(10) },
  { id: '7', type: 'expense', amount: 32.5, description: 'Almoço', category: 'Alimentação', date: at(7) },
  { id: '8', type: 'expense', amount: 210, description: 'Farmácia', category: 'Saúde', date: at(5) },
  { id: '9', type: 'expense', amount: 76.8, description: 'Jantar com amigos', category: 'Lazer', date: at(3) },
  { id: '10', type: 'expense', amount: 28, description: 'Café e lanche', category: 'Alimentação', date: at(0) },
]
