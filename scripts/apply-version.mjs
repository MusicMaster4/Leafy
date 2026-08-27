import { readFileSync, writeFileSync } from 'node:fs'

const index = process.argv.indexOf('--version')
const version = index >= 0 ? process.argv[index + 1] : ''
const parsedVersion = /^(\d+)\.(\d+)\.(\d+)(?:-testing\.(\d+))?$/.exec(version)
if (!parsedVersion) throw new Error('A valid --version is required')
const [, majorText, minorText, patchText, testingText] = parsedVersion
const [major, minor, patch] = [majorText, minorText, patchText].map(Number)
const testing = testingText ? Number(testingText) : null
if (major > 20 || minor > 999 || patch > 999 || (testing !== null && testing > 98)) {
  throw new Error('Version components exceed the Android versionCode range')
}
// Testing builds sort before the stable release of the same core version, and
// every published APK has a strictly increasing Android versionCode.
const androidVersionCode = major * 100_000_000 + minor * 100_000 + patch * 100 + (testing ?? 99)

for (const file of ['package.json', 'package-lock.json']) {
  const value = JSON.parse(readFileSync(file, 'utf8'))
  value.version = version
  if (value.packages?.['']) value.packages[''].version = version
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}
const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'))
config.version = version
config.bundle ??= {}
config.bundle.android ??= {}
config.bundle.android.versionCode = androidVersionCode
writeFileSync('src-tauri/tauri.conf.json', `${JSON.stringify(config, null, 2)}\n`)
for (const file of ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) {
  const source = readFileSync(file, 'utf8')
  const next = file.endsWith('Cargo.toml')
    ? source.replace(/(\[package\][\s\S]*?\nversion\s*=\s*)"[^"]+"/, `$1"${version}"`)
    : source.replace(/(name = "leafy-financas"\r?\nversion = )"[^"]+"/, `$1"${version}"`)
  writeFileSync(file, next)
}
console.log(`Applied Leafy ${version}`)
