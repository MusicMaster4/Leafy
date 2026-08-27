import { spawnSync } from 'node:child_process'

const generateIcons = process.platform === 'win32'
  ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm run icons:generate']]
  : ['npm', ['run', 'icons:generate']]

for (const [command, args] of [
  generateIcons,
  [process.execPath, ['scripts/sync-android-icons.mjs']],
]) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) console.error(result.error.message)
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const diff = spawnSync('git', [
  'diff', '--exit-code', '--',
  'src-tauri/icons',
  'src-tauri/gen/android/app/src/main/res',
  ':(exclude)src-tauri/icons/icon.icns',
], { stdio: 'inherit' })

if (diff.status !== 0) {
  console.error('\nIcon files are stale. Run `npm run icons:generate` and `npm run icons:sync`, then commit the results.')
  process.exit(diff.status ?? 1)
}

console.log('All packaged icons match the Leafy master artwork.')
