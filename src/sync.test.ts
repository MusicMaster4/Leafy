import { describe, expect, it } from 'vitest'
import { decryptSnapshot, encryptSnapshot, parsePairing, serializePairing, type LedgerSnapshot, type PairingDetails } from './sync'
import type { RecurringExpense, Transaction } from './types'

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
const decode = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), char => char.charCodeAt(0))
const key = encode(new Uint8Array(32).fill(7))
const session = encode(new Uint8Array(16).fill(9))
const rows: Transaction[] = [{
  id: 'secure-test-row',
  type: 'expense',
  amount: 12.5,
  description: 'Fictional lunch',
  category: 'Food',
  date: '2026-08-27',
  recurringExpenseId: 'fictional-recurring-rule',
}]
const recurringExpenses: RecurringExpense[] = [{
  id: 'fictional-recurring-rule',
  amount: 12.5,
  description: 'Fictional lunch',
  category: 'Food',
  dayOfMonth: 27,
  startDate: '2026-08-27',
}]
const snapshot: LedgerSnapshot = { transactions: rows, recurringExpenses, currency: 'BRL' }

describe('private sync envelope', () => {
  it('round-trips valid data with AES-GCM', async () => {
    const sealed = await encryptSnapshot(snapshot, key, session)
    expect(sealed).not.toContain('Fictional lunch')
    await expect(decryptSnapshot(sealed, key, session)).resolves.toEqual(snapshot)
  })

  it('rejects tampering and cross-session replay', async () => {
    const sealed = await encryptSnapshot(snapshot, key, session)
    const [iv, encodedCiphertext] = sealed.split('.')
    const changedCiphertext = decode(encodedCiphertext)
    changedCiphertext[0] ^= 1
    const tampered = `${iv}.${encode(changedCiphertext)}`
    await expect(decryptSnapshot(tampered, key, session)).rejects.toThrow()
    await expect(decryptSnapshot(sealed, key, encode(new Uint8Array(16).fill(8)))).rejects.toThrow()
  })

  it('rejects malformed transaction data after authenticated decryption', async () => {
    const invalid = { ...snapshot, transactions: [{ ...rows[0], amount: Number.POSITIVE_INFINITY }] }
    const sealed = await encryptSnapshot(invalid, key, session)
    await expect(decryptSnapshot(sealed, key, session)).rejects.toThrow('Unsupported sync payload')
  })

  it('reads transaction-only snapshots from older version 2 desktops', async () => {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const importedKey = await crypto.subtle.importKey('raw', decode(key), 'AES-GCM', false, ['encrypt'])
    const plaintext = new TextEncoder().encode(JSON.stringify({ version: 2, sessionId: session, updatedAt: new Date().toISOString(), transactions: rows }))
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`leafy-sync:v2:${session}`) }, importedKey, plaintext))
    await expect(decryptSnapshot(`${encode(iv)}.${encode(ciphertext)}`, key, session)).resolves.toEqual({
      transactions: rows,
      recurringExpenses: [],
      currency: 'BRL',
    })
  })
})

describe('pairing QR payload', () => {
  const pairing: PairingDetails = {
    version: 2,
    endpoint: 'https://192.168.100.123:49152/sync',
    token: encode(new Uint8Array(32).fill(1)),
    key: encode(new Uint8Array(32).fill(2)),
    certificate: encode(new Uint8Array(375).fill(3)),
    sessionId: encode(new Uint8Array(16).fill(4)),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    deviceName: 'Leafy Desktop',
    role: 'host',
  }

  it('uses a compact QR payload and round-trips every security field', () => {
    const code = serializePairing(pairing)
    expect(code.length).toBeLessThan(800)
    expect(parsePairing(code)).toEqual({ ...pairing, role: 'mirror' })
  })

  it('still accepts QR codes from earlier version 2 desktop builds', () => {
    const legacy = `leafy://pair?data=${encode(new TextEncoder().encode(JSON.stringify(pairing)))}`
    expect(parsePairing(legacy)).toEqual({ ...pairing, role: 'mirror' })
  })
})
