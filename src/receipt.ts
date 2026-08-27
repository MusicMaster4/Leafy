import type { CurrencyCode, TransactionType } from './types'

export type SharedReceipt = {
  id: string
  name: string
  mimeType: string
  text: string
}

export type ReceiptConfidence = 'high' | 'medium' | 'low'

export type ReceiptDraft = {
  type: TransactionType
  amount: number | null
  date: string
  description: string
  confidence: ReceiptConfidence
  explanation: string
  currency: CurrencyCode | null
}

const expenseSignals = [
  /valor\s+pago/i,
  /pagamento\s+(?:pix\s+)?(?:realizado|efetuado|conclu[ií]do)/i,
  /pix\s+(?:enviado|realizado)/i,
  /transfer[eê]ncia\s+enviada/i,
  /voc[eê]\s+pagou/i,
  /d[eé]bito\s+(?:realizado|efetuado)/i,
  /amount\s+paid/i,
  /payment\s+(?:sent|completed)/i,
]

const incomeSignals = [
  /valor\s+recebido/i,
  /pix\s+recebido/i,
  /recebimento\s+(?:pix\s+)?(?:realizado|confirmado)/i,
  /transfer[eê]ncia\s+recebida/i,
  /voc[eê]\s+recebeu/i,
  /valor\s+creditado/i,
  /amount\s+received/i,
  /payment\s+received/i,
]

const normalizeText = (text: string) => text
  .normalize('NFKC')
  .replace(/\u0000/g, '')
  .replace(/\r/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim()

const parseReceiptAmount = (value: string) => {
  const raw = value.replace(/\s/g, '')
  const comma = raw.lastIndexOf(',')
  const dot = raw.lastIndexOf('.')
  let compact = raw
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? ',' : '.'
    compact = raw.replace(decimal === ',' ? /\./g : /,/g, '').replace(decimal, '.')
  } else if (comma >= 0) {
    compact = raw.replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.')
  } else if (dot >= 0) {
    compact = raw.replace(/,(?=\d{3}(?:\D|$))/g, '')
  }
  const amount = Number(compact)
  return Number.isFinite(amount) && amount > 0 && amount <= 1_000_000_000 ? amount : null
}

function findAmount(text: string) {
  const labeled = text.match(/(?:valor\s+(?:pago|recebido)|valor(?:\s+(?:do|da)\s+(?:pix|transa[cç][aã]o))?|amount\s+(?:paid|received)?)\s*[:\-]?\s*(?:(?:r|us)?\$|€|£)?\s*([\d][\d.,]*[.,]\d{2})/i)
  const fallback = text.match(/(?:(?:r|us)?\$|€|£)\s*([\d][\d.,]*[.,]\d{2})/i)
  return parseReceiptAmount((labeled ?? fallback)?.[1] ?? '')
}

function findDate(text: string) {
  const match = text.match(/\b(0[1-9]|[12]\d|3[01])\/(0[1-9]|1[0-2])\/(20\d{2})\b/)
  if (!match) return new Date().toISOString().slice(0, 10)
  const [, day, month, year] = match
  const candidate = `${year}-${month}-${day}`
  const date = new Date(`${candidate}T12:00:00`)
  return Number.isNaN(date.getTime()) || date.getUTCDate() !== Number(day) ? new Date().toISOString().slice(0, 10) : candidate
}

function findDescription(text: string, type: TransactionType) {
  const recipient = text.match(/(?:^|\n)\s*nome\s*\n\s*([^\n]{2,80})/i)?.[1]?.trim()
  if (recipient && !/^(cpf|cnpj|institui[cç][aã]o)$/i.test(recipient)) {
    return type === 'expense' ? `Pix to ${recipient}` : `Pix from ${recipient}`
  }
  if (/pix/i.test(text)) return type === 'expense' ? 'Pix payment' : 'Pix received'
  return type === 'expense' ? 'Receipt payment' : 'Receipt income'
}

function findCurrency(text: string): CurrencyCode | null {
  if (/r\$\s*[\d.]+,\d{2}/i.test(text)) return 'BRL'
  if (/€\s*[\d.,]+|\bEUR\b/i.test(text)) return 'EUR'
  if (/£\s*[\d.,]+|\bGBP\b/i.test(text)) return 'GBP'
  if (/US\$\s*[\d.,]+|\bUSD\b/i.test(text)) return 'USD'
  if (/(?:^|\s)\$\s*[\d.,]+/i.test(text)) return 'USD'
  return null
}

export function analyzeReceipt(rawText: string): ReceiptDraft {
  const text = normalizeText(rawText).slice(0, 150_000)
  const expenses = expenseSignals.filter(signal => signal.test(text)).length
  const income = incomeSignals.filter(signal => signal.test(text)).length
  const type: TransactionType = income > expenses ? 'income' : 'expense'
  const difference = Math.abs(expenses - income)
  const amount = findAmount(text)
  const confidence: ReceiptConfidence = difference >= 2 && amount ? 'high' : difference >= 1 && amount ? 'medium' : 'low'
  const explanation = difference === 0
    ? 'The receipt does not clearly say whether money was sent or received. Check the direction before saving.'
    : type === 'expense'
      ? 'Payment wording suggests money left your account.'
      : 'Receipt wording suggests money entered your account.'

  return {
    type,
    amount,
    date: findDate(text),
    description: findDescription(text, type),
    confidence,
    explanation,
    currency: findCurrency(text),
  }
}

export function isSharedReceipt(value: unknown): value is SharedReceipt {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string' && item.id.length <= 100
    && typeof item.name === 'string' && item.name.length <= 255
    && typeof item.mimeType === 'string' && item.mimeType.length <= 100
    && typeof item.text === 'string' && item.text.length > 0 && item.text.length <= 150_000
}
