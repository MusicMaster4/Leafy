import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'

function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-testing\.(\d+))?$/.exec(version)
  return match && { major: +match[1], minor: +match[2], patch: +match[3], beta: match[4] ? +match[4] : null }
}

function compare(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

function bump(version, level) {
  if (level === 'major') return { major: version.major + 1, minor: 0, patch: 0 }
  if (level === 'minor') return { major: version.major, minor: version.minor + 1, patch: 0 }
  return { major: version.major, minor: version.minor, patch: version.patch + 1 }
}

function text(version) { return `${version.major}.${version.minor}.${version.patch}` }

const args = process.argv.slice(2)
const readArg = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}
const branch = readArg('--branch', process.env.GITHUB_REF_NAME || 'main')
const level = readArg('--bump', 'patch') || 'patch'
if (!['main', 'testing'].includes(branch)) throw new Error('Only main and testing can publish releases')
if (!['patch', 'minor', 'major'].includes(level)) throw new Error('Bump must be patch, minor, or major')

const packageVersion = parse(JSON.parse(readFileSync('package.json', 'utf8')).version)
if (!packageVersion) throw new Error('package.json has an invalid version')
const tags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean)
const parsed = tags.map(tag => ({ tag, value: parse(tag.slice(1)) })).filter(item => item.value)
const stable = parsed.filter(item => item.value.beta === null).sort((a, b) => compare(b.value, a.value))[0]?.value

let version
if (branch === 'main') {
  version = stable ? text(bump(stable, level)) : text(packageVersion)
} else {
  const target = stable ? bump(stable, level) : packageVersion
  const prefix = text(target)
  const count = parsed.filter(item => item.value.beta !== null && text(item.value) === prefix).reduce((max, item) => Math.max(max, item.value.beta), 0) + 1
  version = `${prefix}-testing.${count}`
}
const output = [`version=${version}`, `tag=v${version}`, `channel=${branch === 'main' ? 'stable' : 'testing'}`]
console.log(output.join('\n'))
if (process.env.GITHUB_OUTPUT && !args.includes('--dry-run')) appendFileSync(process.env.GITHUB_OUTPUT, `${output.join('\n')}\n`)
