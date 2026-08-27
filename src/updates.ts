import { invoke } from '@tauri-apps/api/core'

export interface UpdateCheck {
  currentVersion: string
  latestVersion: string
  available: boolean
  releaseUrl: string
}

export const checkForUpdates = () => invoke<UpdateCheck>('check_for_updates')
export const openRelease = (releaseUrl: string) => invoke<void>('open_release', { releaseUrl })
