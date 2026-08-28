import { invoke } from '@tauri-apps/api/core'
import { checkPermissions, Format, requestPermissions, scan } from '@tauri-apps/plugin-barcode-scanner'
import { isCurrencyCode, type CurrencyCode, type RecurringExpense, type Transaction } from './types'
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
  networkMode?: 'tailscale' | 'local'
  role: 'host' | 'mirror'
}

export type LedgerSnapshot = {
  transactions: Transaction[]
  recurringExpenses: RecurringExpense[]
  currency: CurrencyCode
}

type SyncEnvelope = LedgerSnapshot & {
  version: 2
  sessionId: string
  updatedAt: string
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
    && (row.recurringExpenseId === undefined || (typeof row.recurringExpenseId === 'string' && row.recurringExpenseId.length > 0 && row.recurringExpenseId.length <= 128))
}

function isRecurringExpense(value: unknown): value is RecurringExpense {
  if (!value || typeof value !== 'object') return false
  const rule = value as Partial<RecurringExpense>
  const validDate = (date: unknown) => typeof date === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && !Number.isNaN(Date.parse(`${date}T00:00:00Z`))
  return typeof rule.id === 'string' && rule.id.length > 0 && rule.id.length <= 128
    && typeof rule.amount === 'number' && Number.isFinite(rule.amount) && rule.amount > 0 && rule.amount <= 1_000_000_000_000
    && typeof rule.description === 'string' && rule.description.length > 0 && rule.description.length <= 200
    && typeof rule.category === 'string' && rule.category.length > 0 && rule.category.length <= 50
    && typeof rule.dayOfMonth === 'number' && Number.isInteger(rule.dayOfMonth) && rule.dayOfMonth >= 1 && rule.dayOfMonth <= 31
    && validDate(rule.startDate)
    && (rule.lastGeneratedDate === undefined || validDate(rule.lastGeneratedDate))
}

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
const decode = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), char => char.charCodeAt(0))

async function importKey(value: string) {
  if (decode(value).length !== 32) throw new Error('Invalid encryption key')
  return crypto.subtle.importKey('raw', decode(value), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

const syncContext = (sessionId: string) => new TextEncoder().encode(`leafy-sync:v2:${sessionId}`)

export async function encryptSnapshot(snapshot: LedgerSnapshot, key: string, sessionId: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify({ version: 2, sessionId, updatedAt: new Date().toISOString(), ...snapshot } satisfies SyncEnvelope))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: syncContext(sessionId) }, await importKey(key), plaintext))
  return `${encode(iv)}.${encode(ciphertext)}`
}

export async function decryptSnapshot(payload: string, key: string, sessionId: string) {
  const [iv, ciphertext] = payload.split('.')
  if (!iv || !ciphertext) throw new Error('Invalid encrypted sync payload')
  if (decode(iv).length !== 12 || decode(ciphertext).length > 5_000_000) throw new Error('Invalid encrypted sync payload')
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv), additionalData: syncContext(sessionId) }, await importKey(key), decode(ciphertext))
  const envelope = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<SyncEnvelope>
  if (envelope.version !== 2 || envelope.sessionId !== sessionId || !Array.isArray(envelope.transactions) || !envelope.transactions.every(isTransaction)) throw new Error('Unsupported sync payload')
  // Older version 2 desktops sent only transactions. Defaults preserve that
  // compatibility while newer peers mirror the whole ledger presentation.
  const recurringExpenses = envelope.recurringExpenses ?? []
  const currency = envelope.currency ?? 'BRL'
  if (!Array.isArray(recurringExpenses) || !recurringExpenses.every(isRecurringExpense) || !isCurrencyCode(currency)) throw new Error('Unsupported sync payload')
  return { transactions: envelope.transactions, recurringExpenses, currency } satisfies LedgerSnapshot
}

export async function createPairing(snapshot: LedgerSnapshot): Promise<PairingDetails> {
  const key = encode(crypto.getRandomValues(new Uint8Array(32)))
  const token = encode(crypto.getRandomValues(new Uint8Array(32)))
  const sessionId = encode(crypto.getRandomValues(new Uint8Array(16)))
  const payload = await encryptSnapshot(snapshot, key, sessionId)
  const { endpoint, certificate, networkMode } = await invoke<{ endpoint: string; certificate: string; networkMode: 'tailscale' | 'local' }>('start_pairing_server', { token, payload })
  return {
    version: 2,
    endpoint,
    token,
    key,
    certificate,
    sessionId,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    deviceName: 'Leafy Desktop',
    networkMode,
    role: 'host',
  }
}

export function serializePairing(details: PairingDetails) {
  const query = new URLSearchParams({
    v: String(details.version),
    e: details.endpoint,
    t: details.token,
    k: details.key,
    c: details.certificate,
    s: details.sessionId,
    x: details.expiresAt,
    d: details.deviceName,
    ...(details.networkMode ? { n: details.networkMode } : {}),
  })
  return `leafy://pair?${query}`
}

export function parsePairing(value: string): PairingDetails {
  const url = new URL(value)
  if (url.protocol !== 'leafy:' || url.hostname !== 'pair') throw new Error('This is not a Leafy pairing code')
  const data = url.searchParams.get('data')
  // Keep accepting version 2 codes created by earlier desktop builds.
  const details = data
    ? JSON.parse(new TextDecoder().decode(decode(data))) as PairingDetails
    : {
        version: Number(url.searchParams.get('v')),
        endpoint: url.searchParams.get('e') ?? '',
        token: url.searchParams.get('t') ?? '',
        key: url.searchParams.get('k') ?? '',
        certificate: url.searchParams.get('c') ?? '',
        sessionId: url.searchParams.get('s') ?? '',
        expiresAt: url.searchParams.get('x') ?? '',
        deviceName: url.searchParams.get('d') ?? 'Leafy Desktop',
        ...(url.searchParams.has('n') ? { networkMode: url.searchParams.get('n') === 'tailscale' ? 'tailscale' as const : 'local' as const } : {}),
      } as PairingDetails
  if (details.version !== 2 || !details.endpoint || !details.token || !details.key || !details.certificate || !details.sessionId) throw new Error('Unsupported pairing code')
  if (decode(details.token).length !== 32 || decode(details.key).length !== 32 || decode(details.sessionId).length !== 16) throw new Error('Invalid pairing secrets')
  if (!details.expiresAt || Date.parse(details.expiresAt) <= Date.now()) throw new Error('This pairing code has expired')
  return { ...details, role: 'mirror' }
}

export async function scanPairingCode() {
  let permission = await checkPermissions()
  if (permission !== 'granted') permission = await requestPermissions()
  if (permission !== 'granted') throw new Error('Camera access is required to scan the QR code')
  const result = await scan({ cameraDirection: 'back', formats: [Format.QRCode], windowed: false })
  if (!result.content) throw new Error('The camera did not return a QR code')
  return parsePairing(result.content)
}

export async function savedPeer(): Promise<PairingDetails | null> {
  try {
    const peer = await secureGet<PairingDetails>('peer')
    if (!peer || peer.version !== 2 || !['host', 'mirror'].includes(peer.role) || Date.parse(peer.expiresAt) <= Date.now()) {
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

export async function pullHostedSnapshot(peer: PairingDetails) {
  if (peer.role !== 'host') throw new Error('Only the computer can read its shared ledger')
  const payload = await invoke<string>('read_hosted_sync_snapshot')
  return decryptSnapshot(payload, peer.key, peer.sessionId)
}

export async function publishSnapshot(peer: PairingDetails, snapshot: LedgerSnapshot) {
  const payload = await encryptSnapshot(snapshot, peer.key, peer.sessionId)
  if (peer.role === 'host') {
    await invoke<void>('publish_sync_snapshot', { payload })
    return
  }
  await invoke<void>('sync_upload', {
    endpoint: peer.endpoint,
    certificate: peer.certificate,
    token: peer.token,
    payload,
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
