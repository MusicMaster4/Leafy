import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { checkForUpdates, type UpdateCheck } from './updates'

const currentUpdate: UpdateCheck = {
  currentVersion: '0.1.6-testing.12',
  latestVersion: '0.1.6-testing.13',
  available: true,
  apkUrl: 'https://github.com/MusicMaster4/Leafy/releases/download/v0.1.6-testing.13/leafy-beta.apk',
  updaterUrl: 'https://github.com/MusicMaster4/Leafy/releases/download/v0.1.6-testing.13/latest.json',
}

describe('update checks', () => {
  let events: EventTarget

  beforeEach(() => {
    events = new EventTarget()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        addEventListener: events.addEventListener.bind(events),
        clearTimeout,
        dispatchEvent: events.dispatchEvent.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        setTimeout,
        navigator: { userAgent: 'Leafy test desktop' },
      },
    })
    invoke.mockReset()
  })

  afterEach(() => vi.useRealTimers())

  it('resolves an Android check from the native result event', async () => {
    window.LeafyAndroid = {
      checkForUpdates: () => window.dispatchEvent(new CustomEvent('leafy:update-check-result', { detail: currentUpdate })),
      installUpdate: vi.fn(),
    }

    await expect(checkForUpdates()).resolves.toEqual(currentUpdate)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rejects instead of calling the desktop updater when the Android bridge is unavailable', async () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Linux; Android 16)',
    })

    await expect(checkForUpdates()).rejects.toThrow('Android update checker is unavailable')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('times out a native check that never sends a result', async () => {
    vi.useFakeTimers()
    window.setTimeout = globalThis.setTimeout
    window.clearTimeout = globalThis.clearTimeout
    window.LeafyAndroid = { checkForUpdates: vi.fn(), installUpdate: vi.fn() }

    const check = checkForUpdates()
    const rejected = expect(check).rejects.toThrow('Update check timed out')
    await vi.advanceTimersByTimeAsync(12_000)

    await rejected
  })

  it('uses the bounded desktop command outside Android', async () => {
    invoke.mockResolvedValue(currentUpdate)

    await expect(checkForUpdates()).resolves.toEqual(currentUpdate)
    expect(invoke).toHaveBeenCalledWith('check_for_updates')
  })
})
