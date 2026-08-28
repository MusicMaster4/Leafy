const databaseName = 'leafy-private-storage'
const storeName = 'keys'
const keyName = 'device-key-v1'

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
const decode = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), char => char.charCodeAt(0))

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(storeName)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

let keyPromise: Promise<CryptoKey> | undefined
const pendingWrites = new Map<string, Promise<void>>()

async function loadDeviceKey() {
  const database = await openDatabase()
  const transaction = database.transaction(storeName, 'readonly')
  const store = transaction.objectStore(storeName)
  const stored = await new Promise<CryptoKey | undefined>((resolve, reject) => {
    const request = store.get(keyName)
    request.onsuccess = () => resolve(request.result as CryptoKey | undefined)
    request.onerror = () => reject(request.error)
  })
  database.close()
  if (stored) {
    return stored
  }
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const writeDatabase = await openDatabase()
  const writeStore = writeDatabase.transaction(storeName, 'readwrite').objectStore(storeName)
  await new Promise<void>((resolve, reject) => {
    const request = writeStore.put(key, keyName)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
  writeDatabase.close()
  return key
}

function deviceKey() {
  keyPromise ??= loadDeviceKey()
  return keyPromise
}

const additionalData = (name: string) => new TextEncoder().encode(`leafy-storage:v1:${name}`)

function afterPendingWrite(name: string) {
  return pendingWrites.get(name)?.catch(() => undefined) ?? Promise.resolve()
}

function enqueueWrite(name: string, operation: () => Promise<void> | void) {
  const queued = afterPendingWrite(name).then(operation)
  pendingWrites.set(name, queued)
  return queued.finally(() => {
    if (pendingWrites.get(name) === queued) pendingWrites.delete(name)
  })
}

export async function secureGet<T>(name: string): Promise<T | null> {
  await afterPendingWrite(name)
  const sealed = localStorage.getItem(`leafy-secure:${name}`)
  if (!sealed) return null
  const [iv, ciphertext] = sealed.split('.')
  if (!iv || !ciphertext) throw new Error('Secure storage is corrupted')
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decode(iv), additionalData: additionalData(name) },
    await deviceKey(),
    decode(ciphertext),
  )
  return JSON.parse(new TextDecoder().decode(plaintext)) as T
}

export async function secureSet(name: string, value: unknown) {
  return enqueueWrite(name, async () => {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const plaintext = new TextEncoder().encode(JSON.stringify(value))
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: additionalData(name) },
      await deviceKey(),
      plaintext,
    ))
    localStorage.setItem(`leafy-secure:${name}`, `${encode(iv)}.${encode(ciphertext)}`)
  })
}

export async function secureRemove(name: string) {
  return enqueueWrite(name, () => localStorage.removeItem(`leafy-secure:${name}`))
}
