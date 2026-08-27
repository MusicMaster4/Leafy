import { invoke } from '@tauri-apps/api/core'
import { checkPermissions, Format, requestPermissions, scan } from '@tauri-apps/plugin-barcode-scanner'
import type { Transaction } from './types'
import { secureGet, secureRemove, secureSet } from './storage'

export type PairingDetails = {
  version: 2
  endpoint: string
  token: string
  key: string
  certificate: string
  sessionId: string
  expiresAt: string
  deviceName: string
}

type SyncEnvelope = {
  version: 2
  sessionId: string
  updatedAt: string
  transactions: Transaction[]
}

function isTransaction(value: unknown): value is Transaction {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<Transaction>
  return typeof row.id === 'string' && row.id.length > 0 && row.id.length <= 128
    && (row.type === 'expense' || row.type === 'income')
    && typeof row.amount === 'number' && Number.isFinite(row.amount) && row.amount > 0 && row.amount <= 1_000_000_000_000
    && typeof row.description === 'string' && row.description.length > 0 && row.description.length <= 200
    && typeof row.category === 'string' && row.category.length > 0 && row.category.length <= 50
    && typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date) && !Number.isNaN(Date.parse(`${row.date}T00:00:00Z`))
}

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
const decode = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), char => char.charCodeAt(0))

async function importKey(value: string) {
  if (decode(value).length !== 32) throw new Error('Invalid encryption key')
  return crypto.subtle.importKey('raw', decode(value), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

const syncContext = (sessionId: string) => new TextEncoder().encode(`leafy-sync:v2:${sessionId}`)

export async function encryptSnapshot(transactions: Transaction[], key: string, sessionId: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify({ version: 2, sessionId, updatedAt: new Date().toISOString(), transactions } satisfies SyncEnvelope))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: syncContext(sessionId) }, await importKey(key), plaintext))
  return `${encode(iv)}.${encode(ciphertext)}`
}

export async function decryptSnapshot(payload: string, key: string, sessionId: string) {
  const [iv, ciphertext] = payload.split('.')
  if (!iv || !ciphertext) throw new Error('Invalid encrypted sync payload')
  if (decode(iv).length !== 12 || decode(ciphertext).length > 5_000_000) throw new Error('Invalid encrypted sync payload')
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv), additionalData: syncContext(sessionId) }, await importKey(key), decode(ciphertext))
  const envelope = JSON.parse(new TextDecoder().decode(plaintext)) as SyncEnvelope
  if (envelope.version !== 2 || envelope.sessionId !== sessionId || !Array.isArray(envelope.transactions) || !envelope.transactions.every(isTransaction)) throw new Error('Unsupported sync payload')
  return envelope.transactions
}

export async function createPairing(transactions: Transaction[]): Promise<PairingDetails> {
  const key = encode(crypto.getRandomValues(new Uint8Array(32)))
  const token = encode(crypto.getRandomValues(new Uint8Array(32)))
  const sessionId = encode(crypto.getRandomValues(new Uint8Array(16)))
  const payload = await encryptSnapshot(transactions, key, sessionId)
  const { endpoint, certificate } = await invoke<{ endpoint: string; certificate: string }>('start_pairing_server', { token, payload })
  return {
    version: 2,
    endpoint,
    token,
    key,
    certificate,
    sessionId,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    deviceName: 'Leafy Desktop',
  }
}

export function serializePairing(details: PairingDetails) {
  return `leafy://pair?data=${encode(new TextEncoder().encode(JSON.stringify(details)))}`
}

export function parsePairing(value: string): PairingDetails {
  const url = new URL(value)
  if (url.protocol !== 'leafy:' || url.hostname !== 'pair') throw new Error('This is not a Leafy pairing code')
  const data = url.searchParams.get('data')
  if (!data) throw new Error('Pairing details are missing')
  const details = JSON.parse(new TextDecoder().decode(decode(data))) as PairingDetails
  if (details.version !== 2 || !details.endpoint || !details.token || !details.key || !details.certificate || !details.sessionId) throw new Error('Unsupported pairing code')
  if (decode(details.token).length !== 32 || decode(details.key).length !== 32 || decode(details.sessionId).length !== 16) throw new Error('Invalid pairing secrets')
  if (!details.expiresAt || Date.parse(details.expiresAt) <= Date.now()) throw new Error('This pairing code has expired')
  return details
}

export async function scanPairingCode() {
  let permission = await checkPermissions()
  if (permission !== 'granted') permission = await requestPermissions()
  if (permission !== 'granted') throw new Error('Camera access is required to scan the QR code')
  const result = await scan({ cameraDirection: 'back', formats: [Format.QRCode] })
  return parsePairing(result.content)
}

export async function savedPeer(): Promise<PairingDetails | null> {
  try {
    const peer = await secureGet<PairingDetails>('peer')
    if (!peer || peer.version !== 2 || Date.parse(peer.expiresAt) <= Date.now()) {
      secureRemove('peer')
      return null
    }
    return peer
  } catch { return null }
}

export async function pullFromPeer(peer: PairingDetails) {
  const payload = await invoke<string>('sync_download', {
    endpoint: peer.endpoint,
    certificate: peer.certificate,
    token: peer.token,
  })
  return decryptSnapshot(payload, peer.key, peer.sessionId)
}

export async function pushToPeer(peer: PairingDetails, transactions: Transaction[]) {
  await invoke<void>('sync_upload', {
    endpoint: peer.endpoint,
    certificate: peer.certificate,
    token: peer.token,
    payload: await encryptSnapshot(transactions, peer.key, peer.sessionId),
  })
}

export async function rememberPeer(peer: PairingDetails) {
  await secureSet('peer', peer)
  localStorage.removeItem('leafy-peer')
}

export function forgetPeer() {
  secureRemove('peer')
  localStorage.removeItem('leafy-peer')
}

export function mergeTransactions(current: Transaction[], incoming: Transaction[]) {
  const rows = new Map(current.map(row => [row.id, row]))
  incoming.forEach(row => rows.set(row.id, row))
  return [...rows.values()].sort((a, b) => b.date.localeCompare(a.date))
}
