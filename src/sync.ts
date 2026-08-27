import { invoke } from '@tauri-apps/api/core'
import { checkPermissions, Format, requestPermissions, scan } from '@tauri-apps/plugin-barcode-scanner'
import type { Transaction } from './types'

export type PairingDetails = {
  version: 1
  endpoint: string
  token: string
  key: string
  deviceName: string
}

type SyncEnvelope = {
  version: 1
  updatedAt: string
  transactions: Transaction[]
}

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
const decode = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), char => char.charCodeAt(0))

async function importKey(value: string) {
  return crypto.subtle.importKey('raw', decode(value), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function encryptSnapshot(transactions: Transaction[], key: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), transactions } satisfies SyncEnvelope))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await importKey(key), plaintext))
  return `${encode(iv)}.${encode(ciphertext)}`
}

export async function decryptSnapshot(payload: string, key: string) {
  const [iv, ciphertext] = payload.split('.')
  if (!iv || !ciphertext) throw new Error('Invalid encrypted sync payload')
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv) }, await importKey(key), decode(ciphertext))
  const envelope = JSON.parse(new TextDecoder().decode(plaintext)) as SyncEnvelope
  if (envelope.version !== 1 || !Array.isArray(envelope.transactions)) throw new Error('Unsupported sync payload')
  return envelope.transactions
}

export async function createPairing(transactions: Transaction[]): Promise<PairingDetails> {
  const key = encode(crypto.getRandomValues(new Uint8Array(32)))
  const token = encode(crypto.getRandomValues(new Uint8Array(32)))
  const payload = await encryptSnapshot(transactions, key)
  const { endpoint } = await invoke<{ endpoint: string }>('start_pairing_server', { token, payload })
  const details: PairingDetails = { version: 1, endpoint, token, key, deviceName: 'Leafy Desktop' }
  localStorage.setItem('leafy-peer', JSON.stringify(details))
  return details
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
  if (details.version !== 1 || !details.endpoint || !details.token || !details.key) throw new Error('Unsupported pairing code')
  return details
}

export async function scanPairingCode() {
  let permission = await checkPermissions()
  if (permission !== 'granted') permission = await requestPermissions()
  if (permission !== 'granted') throw new Error('Camera access is required to scan the QR code')
  const result = await scan({ cameraDirection: 'back', formats: [Format.QRCode] })
  return parsePairing(result.content)
}

export function savedPeer(): PairingDetails | null {
  try { return JSON.parse(localStorage.getItem('leafy-peer') || 'null') }
  catch { return null }
}

export async function pullFromPeer(peer: PairingDetails) {
  const response = await fetch(peer.endpoint, { headers: { Authorization: `Bearer ${peer.token}` } })
  if (!response.ok) throw new Error(`Sync connection returned ${response.status}`)
  return decryptSnapshot(await response.text(), peer.key)
}

export async function pushToPeer(peer: PairingDetails, transactions: Transaction[]) {
  const response = await fetch(peer.endpoint, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${peer.token}`, 'Content-Type': 'text/plain' },
    body: await encryptSnapshot(transactions, peer.key),
  })
  if (!response.ok) throw new Error(`Sync connection returned ${response.status}`)
}

export function rememberPeer(peer: PairingDetails) {
  localStorage.setItem('leafy-peer', JSON.stringify(peer))
}

export function forgetPeer() {
  localStorage.removeItem('leafy-peer')
}

export function mergeTransactions(current: Transaction[], incoming: Transaction[]) {
  const rows = new Map(current.map(row => [row.id, row]))
  incoming.forEach(row => rows.set(row.id, row))
  return [...rows.values()].sort((a, b) => b.date.localeCompare(a.date))
}
