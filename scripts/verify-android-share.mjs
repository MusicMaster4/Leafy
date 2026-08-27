import { readFile } from 'node:fs/promises'

const manifestPath = new URL('../src-tauri/gen/android/app/src/main/AndroidManifest.xml', import.meta.url)
const activityPath = new URL('../src-tauri/gen/android/app/src/main/java/app/leafy/financas/MainActivity.kt', import.meta.url)
const filePathsPath = new URL('../src-tauri/gen/android/app/src/main/res/xml/file_paths.xml', import.meta.url)
const [manifest, activity, filePaths] = await Promise.all([
  readFile(manifestPath, 'utf8'),
  readFile(activityPath, 'utf8'),
  readFile(filePathsPath, 'utf8'),
])

const filters = manifest.match(/<intent-filter>[\s\S]*?<\/intent-filter>/g) ?? []
for (const mimeType of ['application/pdf', 'image/*', 'text/plain']) {
  const valid = filters.some(filter => filter.includes('android.intent.action.SEND')
    && filter.includes('android.intent.category.DEFAULT')
    && filter.includes(`android:mimeType="${mimeType}"`))
  if (!valid) throw new Error(`Android Share Sheet target is missing for ${mimeType}`)
}

for (const required of [
  'android:launchMode="singleTask"',
  'android:allowBackup="false"',
  'android:usesCleartextTraffic="false"',
  'android:dataExtractionRules="@xml/data_extraction_rules"',
]) {
  if (!manifest.includes(required)) throw new Error(`Android security setting is missing: ${required}`)
}

if (manifest.includes('LEANBACK_LAUNCHER')) throw new Error('Phone app must not expose an incomplete Android TV launcher')
if (filePaths.includes('<external-path')) throw new Error('FileProvider must not expose the shared external-storage root')
if (!filePaths.includes('<external-files-path') || !filePaths.includes('path="Pictures/"')) {
  throw new Error('FileProvider must be limited to Leafy-owned picture storage')
}

for (const required of [
  'override fun onNewIntent',
  'override fun onWebViewCreate',
  'uri.scheme != "content"',
  'MAX_SHARED_BYTES',
  'MAX_PDF_PAGES',
  'leafy:shared-receipt',
]) {
  if (!activity.includes(required)) throw new Error(`Android share handler is incomplete: ${required}`)
}

console.log('Android Share Sheet receipt targets and safety controls are present.')
