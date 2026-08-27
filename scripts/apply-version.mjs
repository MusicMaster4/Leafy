import { readFileSync, writeFileSync } from 'node:fs'

const index = process.argv.indexOf('--version')
const version = index >= 0 ? process.argv[index + 1] : ''
if (!/^\d+\.\d+\.\d+(?:-testing\.\d+)?$/.test(version)) throw new Error('A valid --version is required')

for (const file of ['package.json', 'package-lock.json']) {
  const value = JSON.parse(readFileSync(file, 'utf8'))
  value.version = version
  if (value.packages?.['']) value.packages[''].version = version
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}
const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'))
config.version = version
writeFileSync('src-tauri/tauri.conf.json', `${JSON.stringify(config, null, 2)}\n`)
for (const file of ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) {
  const source = readFileSync(file, 'utf8')
  const next = file.endsWith('Cargo.toml')
    ? source.replace(/(\[package\][\s\S]*?\nversion\s*=\s*)"[^"]+"/, `$1"${version}"`)
    : source.replace(/(name = "leafy-financas"\r?\nversion = )"[^"]+"/, `$1"${version}"`)
  writeFileSync(file, next)
}
console.log(`Applied Leafy ${version}`)
