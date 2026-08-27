import { invoke } from '@tauri-apps/api/core'

export interface UpdateCheck {
  currentVersion: string
  latestVersion: string
  available: boolean
  apkUrl: string | null
  updaterUrl: string
}

declare global {
  interface Window {
    LeafyAndroid?: {
      checkForUpdates?: () => void
      installUpdate: (apkUrl: string) => void
    }
  }
}

const UPDATE_CHECK_TIMEOUT_MS = 12_000

const validUpdateCheck = (value: unknown): value is UpdateCheck => {
  if (!value || typeof value !== 'object') return false
  const update = value as Partial<UpdateCheck>
  return typeof update.currentVersion === 'string'
    && typeof update.latestVersion === 'string'
    && typeof update.available === 'boolean'
    && (update.apkUrl === null || typeof update.apkUrl === 'string')
    && typeof update.updaterUrl === 'string'
}

const withTimeout = <T>(operation: Promise<T>) => new Promise<T>((resolve, reject) => {
  const timer = window.setTimeout(() => reject(new Error('Update check timed out')), UPDATE_CHECK_TIMEOUT_MS)
  operation.then(
    value => { window.clearTimeout(timer); resolve(value) },
    error => { window.clearTimeout(timer); reject(error) },
  )
})

const checkAndroidUpdates = () => new Promise<UpdateCheck>((resolve, reject) => {
  const bridge = window.LeafyAndroid
  if (typeof bridge?.checkForUpdates !== 'function') {
    reject(new Error('Android update checker is unavailable'))
    return
  }

  const finish = () => {
    window.clearTimeout(timer)
    window.removeEventListener('leafy:update-check-result', receiveResult)
    window.removeEventListener('leafy:update-check-error', receiveError)
  }
  const receiveResult = (event: Event) => {
    const result = (event as CustomEvent<unknown>).detail
    finish()
    if (validUpdateCheck(result)) resolve(result)
    else reject(new Error('Android returned an invalid update result'))
  }
  const receiveError = (event: Event) => {
    const message = (event as CustomEvent<{ message?: unknown }>).detail?.message
    finish()
    reject(new Error(typeof message === 'string' ? message : 'Could not check for updates'))
  }
  const timer = window.setTimeout(() => {
    finish()
    reject(new Error('Update check timed out'))
  }, UPDATE_CHECK_TIMEOUT_MS)

  window.addEventListener('leafy:update-check-result', receiveResult)
  window.addEventListener('leafy:update-check-error', receiveError)
  try {
    bridge.checkForUpdates()
  } catch (error) {
    finish()
    reject(error)
  }
})

export const checkForUpdates = () => typeof window.LeafyAndroid?.checkForUpdates === 'function'
  ? checkAndroidUpdates()
  : withTimeout(invoke<UpdateCheck>('check_for_updates'))
export const canInstallAndroidUpdate = () => typeof window.LeafyAndroid?.installUpdate === 'function'
export const installAndroidUpdate = (apkUrl: string) => {
  if (!window.LeafyAndroid) throw new Error('Android installer is unavailable')
  window.LeafyAndroid.installUpdate(apkUrl)
}
export const installDesktopUpdate = (updaterUrl: string) => invoke<void>('install_desktop_update', { updaterUrl })
