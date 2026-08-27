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
    LeafyAndroid?: { installUpdate: (apkUrl: string) => void }
  }
}

export const checkForUpdates = () => invoke<UpdateCheck>('check_for_updates')
export const canInstallAndroidUpdate = () => typeof window.LeafyAndroid?.installUpdate === 'function'
export const installAndroidUpdate = (apkUrl: string) => {
  if (!window.LeafyAndroid) throw new Error('Android installer is unavailable')
  window.LeafyAndroid.installUpdate(apkUrl)
}
export const installDesktopUpdate = (updaterUrl: string) => invoke<void>('install_desktop_update', { updaterUrl })
