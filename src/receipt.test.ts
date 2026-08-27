import { describe, expect, it } from 'vitest'
import { analyzeReceipt, isSharedReceipt } from './receipt'

describe('receipt analysis', () => {
  it('recognizes a sanitized outgoing Pix receipt', () => {
    const result = analyzeReceipt(`
      Comprovante do Pix
      Valor pago
      R$ 125,90
      Nome
      Fictional Market Ltda
      Data e hora da Transação
      17/08/2026 13:42:10
      Pagamento realizado
    `)
    expect(result).toMatchObject({
      type: 'expense',
      amount: 125.9,
      date: '2026-08-17',
      description: 'Pix to Fictional Market Ltda',
      confidence: 'high',
      currency: 'BRL',
    })
  })

  it('recognizes received money and Brazilian thousands separators', () => {
    const result = analyzeReceipt('Pix recebido\nValor recebido: R$ 1.234,56\nTransferência recebida\n02/07/2026')
    expect(result.type).toBe('income')
    expect(result.amount).toBe(1234.56)
    expect(result.confidence).toBe('high')
  })

  it('recognizes a dollar amount without treating commas as decimals', () => {
    const result = analyzeReceipt('Payment completed\nAmount paid: $1,234.56\n27/08/2026')
    expect(result.amount).toBe(1234.56)
    expect(result.currency).toBe('USD')
  })

  it('flags ambiguous receipts for careful review', () => {
    const result = analyzeReceipt('Comprovante bancário\nR$ 10,00\n01/08/2026')
    expect(result.confidence).toBe('low')
    expect(result.explanation).toContain('does not clearly say')
  })

  it('rejects malformed or oversized native payloads', () => {
    expect(isSharedReceipt({ id: '1', name: 'receipt.pdf', mimeType: 'application/pdf', text: 'ok' })).toBe(true)
    expect(isSharedReceipt({ id: '1', name: 'receipt.pdf', mimeType: 'application/pdf', text: '' })).toBe(false)
    expect(isSharedReceipt({ id: '1', name: 'receipt.pdf', mimeType: 'application/pdf', text: 'x'.repeat(150_001) })).toBe(false)
  })
})
