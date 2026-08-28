import { invoke } from '@tauri-apps/api/core'
import { checkPermissions, Format, requestPermissions, scan } from '@tauri-apps/plugin-barcode-scanner'
import { isCurrencyCode, type CurrencyCode, type RecurringExpense, type Transaction } from './types'
import { secureGet, secureRemove, secureSet } from './storage'

export type PairingDetails = {
  version: 2 | 3
  endpoint: string
  /** Durable request credential after pairing; a one-hour invitation before it. */
  token: string
  /** Host-only invitation credential. It is the only token placed in a v3 QR code. */
  pairingToken?: string
  key: string
  certificate: string
  sessionId: string
  expiresAt: string
  deviceName: string
  networkMode?: 'tailscale' | 'local'
  /** Stored only on the host. It is deliberately never serialized into the QR code. */
  serverKey?: string
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

export type RemoteLedgerSnapshot = {
  snapshot: LedgerSnapshot
  revision: number
}

type SyncCheckpoint = {
  sessionId: string
  snapshot: LedgerSnapshot
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

function isLedgerSnapshot(value: unknown): value is LedgerSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<LedgerSnapshot>
  return Array.isArray(snapshot.transactions) && snapshot.transactions.every(isTransaction)
    && Array.isArray(snapshot.recurringExpenses) && snapshot.recurringExpenses.every(isRecurringExpense)
    && isCurrencyCode(snapshot.currency)
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
  const pairingToken = encode(crypto.getRandomValues(new Uint8Array(32)))
  const sessionId = encode(crypto.getRandomValues(new Uint8Array(16)))
  const payload = await encryptSnapshot(snapshot, key, sessionId)
  const { endpoint, certificate, serverKey, networkMode } = await invoke<{ endpoint: string; certificate: string; serverKey: string; networkMode: 'tailscale' | 'local' }>('start_pairing_server', { token, pairingToken, pairingTtlSeconds: 60 * 60, payload })
  return {
    version: 3,
    endpoint,
    token,
    pairingToken,
    key,
    certificate,
    sessionId,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    deviceName: 'Leafy Desktop',
    networkMode,
    serverKey,
    role: 'host',
  }
}

export function serializePairing(details: PairingDetails) {
  const query = new URLSearchParams({
    v: String(details.version),
    e: details.endpoint,
    t: details.version === 3 ? details.pairingToken ?? '' : details.token,
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
  if (![2, 3].includes(details.version) || !details.endpoint || !details.token || !details.key || !details.certificate || !details.sessionId) throw new Error('Unsupported pairing code')
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
    // expiresAt limits use of the QR code, not the lifetime of an established
    // connection. Legacy host records have no private TLS key and cannot be
    // resumed after the desktop process exits, so they must be paired once
    // more after upgrading.
    if (!peer
      || ![2, 3].includes(peer.version)
      || !['host', 'mirror'].includes(peer.role)
      || peer.version === 2 && Date.parse(peer.expiresAt) <= Date.now()
      || peer.role === 'host' && (!peer.serverKey || peer.version === 3 && !peer.pairingToken)) {
      await Promise.all([secureRemove('peer'), secureRemove('sync-checkpoint')])
      return null
    }
    return peer
  } catch { return null }
}

export async function completePairing(peer: PairingDetails): Promise<PairingDetails> {
  if (peer.version === 2) return peer
  const token = await invoke<string>('complete_pairing', {
    endpoint: peer.endpoint,
    certificate: peer.certificate,
    token: peer.token,
  })
  if (decode(token).length !== 32) throw new Error('The computer returned an invalid device credential')
  return { ...peer, token }
}

async function decodeRemote(remote: { payload: string; revision: number }, peer: PairingDetails): Promise<RemoteLedgerSnapshot> {
  if (!Number.isSafeInteger(remote.revision) || remote.revision < 0) throw new Error('Private sync returned an invalid revision')
  return { snapshot: await decryptSnapshot(remote.payload, peer.key, peer.sessionId), revision: remote.revision }
}

export async function pullFromPeer(peer: PairingDetails): Promise<RemoteLedgerSnapshot> {
  const remote = await invoke<{ payload: string; revision: number }>('sync_download', {
    endpoint: peer.endpoint,
    certificate: peer.certificate,
    token: peer.token,
  })
  return decodeRemote(remote, peer)
}

export async function pullHostedSnapshot(peer: PairingDetails): Promise<RemoteLedgerSnapshot> {
  if (peer.role !== 'host') throw new Error('Only the computer can read its shared ledger')
  return decodeRemote(await invoke<{ payload: string; revision: number }>('read_hosted_sync_snapshot'), peer)
}

export async function publishSnapshot(peer: PairingDetails, snapshot: LedgerSnapshot, expectedRevision: number) {
  const payload = await encryptSnapshot(snapshot, peer.key, peer.sessionId)
  if (peer.role === 'host') {
    return invoke<number>('publish_sync_snapshot', { payload, expectedRevision })
  }
  return invoke<number>('sync_upload', {
    endpoint: peer.endpoint,
    certificate: peer.certificate,
    token: peer.token,
    payload,
    expectedRevision,
  })
}

export async function resumeHostedSync(peer: PairingDetails, snapshot: LedgerSnapshot) {
  if (peer.role !== 'host' || !peer.serverKey) throw new Error('Pair this computer again to resume private sync')
  await invoke<void>('resume_pairing_server', {
    endpoint: peer.endpoint,
    token: peer.token,
    pairingToken: peer.pairingToken ?? peer.token,
    pairingTtlSeconds: Math.max(0, Math.ceil((Date.parse(peer.expiresAt) - Date.now()) / 1000)),
    certificate: peer.certificate,
    serverKey: peer.serverKey,
    payload: await encryptSnapshot(snapshot, peer.key, peer.sessionId),
  })
}

function stableRecord<T extends { id: string }>(value: T | undefined) {
  return value === undefined ? '' : JSON.stringify(value)
}

function mergeRecords<T extends { id: string }>(baseRows: T[], localRows: T[], remoteRows: T[]) {
  const base = new Map(baseRows.map(row => [row.id, row]))
  const local = new Map(localRows.map(row => [row.id, row]))
  const remote = new Map(remoteRows.map(row => [row.id, row]))
  const ids = new Set([...base.keys(), ...local.keys(), ...remote.keys()])
  const merged: T[] = []
  for (const id of ids) {
    const original = base.get(id)
    const left = local.get(id)
    const right = remote.get(id)
    const originalKey = stableRecord(original)
    const leftKey = stableRecord(left)
    const rightKey = stableRecord(right)
    let selected: T | undefined
    if (leftKey === rightKey) selected = left
    else if (leftKey === originalKey) selected = right
    else if (rightKey === originalKey) selected = left
    // An edit concurrent with a deletion keeps the edited record. For two
    // concurrent edits, a stable comparison makes every device converge.
    else if (!left) selected = right
    else if (!right) selected = left
    else selected = leftKey > rightKey ? left : right
    if (selected) merged.push(selected)
  }
  return merged.sort((left, right) => left.id.localeCompare(right.id))
}

export function canonicalSnapshot(snapshot: LedgerSnapshot): LedgerSnapshot {
  return {
    transactions: [...snapshot.transactions].sort((left, right) => left.id.localeCompare(right.id)),
    recurringExpenses: [...snapshot.recurringExpenses].sort((left, right) => left.id.localeCompare(right.id)),
    currency: snapshot.currency,
  }
}

export function snapshotEquals(left: LedgerSnapshot, right: LedgerSnapshot) {
  return JSON.stringify(canonicalSnapshot(left)) === JSON.stringify(canonicalSnapshot(right))
}

export function mergeSnapshots(base: LedgerSnapshot | null, local: LedgerSnapshot, remote: LedgerSnapshot): LedgerSnapshot {
  const original = base ?? { transactions: [], recurringExpenses: [], currency: 'BRL' as const }
  const currency = local.currency === remote.currency
    ? local.currency
    : local.currency === original.currency
      ? remote.currency
      : remote.currency === original.currency
        ? local.currency
        : local.currency > remote.currency ? local.currency : remote.currency
  return {
    transactions: mergeRecords(original.transactions, local.transactions, remote.transactions),
    recurringExpenses: mergeRecords(original.recurringExpenses, local.recurringExpenses, remote.recurringExpenses),
    currency,
  }
}

export async function savedSyncCheckpoint(peer: PairingDetails) {
  try {
    const checkpoint = await secureGet<SyncCheckpoint>('sync-checkpoint')
    return checkpoint?.sessionId === peer.sessionId && isLedgerSnapshot(checkpoint.snapshot)
      ? canonicalSnapshot(checkpoint.snapshot)
      : null
  } catch { return null }
}

export async function rememberSyncCheckpoint(peer: PairingDetails, snapshot: LedgerSnapshot) {
  const canonical = canonicalSnapshot(snapshot)
  // Persist the ledger before advancing its common sync checkpoint. If the
  // process is stopped between these writes, the next launch sees an older
  // checkpoint and safely retries the merge instead of mistaking stale local
  // storage for a new deletion.
  await Promise.all([
    secureSet('transactions', canonical.transactions),
    secureSet('recurring-expenses', canonical.recurringExpenses),
    secureSet('currency', canonical.currency),
  ])
  await secureSet('sync-checkpoint', { sessionId: peer.sessionId, snapshot: canonical } satisfies SyncCheckpoint)
}

export async function rememberPeer(peer: PairingDetails) {
  await secureSet('peer', peer)
  localStorage.removeItem('leafy-peer')
}

export async function forgetPeer() {
  await Promise.allSettled([
    invoke<void>('stop_pairing_server'),
    secureRemove('peer'),
    secureRemove('sync-checkpoint'),
  ])
  localStorage.removeItem('leafy-peer')
}
