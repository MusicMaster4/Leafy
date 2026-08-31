import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { secureGet, secureRemove, secureSet } from './storage'

const values = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  },
})

describe('encrypted local storage', () => {
  beforeEach(() => values.clear())

  it('never writes financial records as plaintext', async () => {
    await secureSet('transactions', [{ description: 'Private fictional expense', amount: 42 }])
    const sealed = values.get('leafy-secure:transactions') ?? ''
    expect(sealed).not.toContain('Private fictional expense')
    await expect(secureGet('transactions')).resolves.toEqual([{ description: 'Private fictional expense', amount: 42 }])
  })

  it('binds ciphertext to its storage purpose', async () => {
    await secureSet('transactions', [{ amount: 42 }])
    values.set('leafy-secure:peer', values.get('leafy-secure:transactions') ?? '')
    await expect(secureGet('peer')).rejects.toThrow()
  })

  it('seals API keys and preferences for persistence across app updates', async () => {
    await secureSet('openrouter-key', 'sk-or-v1-fictional-test-key')
    await secureSet('dashboard-preferences', { days: 90, showBalance: false })
    expect(values.get('leafy-secure:openrouter-key')).not.toContain('fictional-test-key')
    await expect(secureGet('openrouter-key')).resolves.toBe('sk-or-v1-fictional-test-key')
    await expect(secureGet('dashboard-preferences')).resolves.toEqual({ days: 90, showBalance: false })
  })

  it('removes encrypted records', async () => {
    await secureSet('peer', { token: 'fictional' })
    await secureRemove('peer')
    await expect(secureGet('peer')).resolves.toBeNull()
  })

  it('serializes rapid writes so the newest value always wins', async () => {
    await Promise.all([
      secureSet('transactions', { revision: 1 }),
      secureSet('transactions', { revision: 2 }),
      secureSet('transactions', { revision: 3 }),
    ])
    await expect(secureGet('transactions')).resolves.toEqual({ revision: 3 })
  })
})
