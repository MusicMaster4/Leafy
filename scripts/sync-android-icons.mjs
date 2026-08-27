import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const generated = join(root, 'src-tauri', 'icons', 'android')
const androidResources = join(root, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res')

const resources = [
  ['mipmap-hdpi', 'ic_launcher.png'],
  ['mipmap-hdpi', 'ic_launcher_foreground.png'],
  ['mipmap-hdpi', 'ic_launcher_round.png'],
  ['mipmap-mdpi', 'ic_launcher.png'],
  ['mipmap-mdpi', 'ic_launcher_foreground.png'],
  ['mipmap-mdpi', 'ic_launcher_round.png'],
  ['mipmap-xhdpi', 'ic_launcher.png'],
  ['mipmap-xhdpi', 'ic_launcher_foreground.png'],
  ['mipmap-xhdpi', 'ic_launcher_round.png'],
  ['mipmap-xxhdpi', 'ic_launcher.png'],
  ['mipmap-xxhdpi', 'ic_launcher_foreground.png'],
  ['mipmap-xxhdpi', 'ic_launcher_round.png'],
  ['mipmap-xxxhdpi', 'ic_launcher.png'],
  ['mipmap-xxxhdpi', 'ic_launcher_foreground.png'],
  ['mipmap-xxxhdpi', 'ic_launcher_round.png'],
]

for (const [folder, filename] of resources) {
  const destination = join(androidResources, folder, filename)
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(join(generated, folder, filename), destination)
}

const generatedAdaptiveIcon = await readFile(join(generated, 'mipmap-anydpi-v26', 'ic_launcher.xml'), 'utf8')
const adaptiveIconPath = join(androidResources, 'mipmap-anydpi-v26', 'ic_launcher.xml')
await mkdir(dirname(adaptiveIconPath), { recursive: true })
await writeFile(adaptiveIconPath, generatedAdaptiveIcon.replace(
  '</adaptive-icon>',
  '  <monochrome android:drawable="@mipmap/ic_launcher_foreground"/>\n</adaptive-icon>',
))

const generatedColors = await readFile(join(generated, 'values', 'ic_launcher_background.xml'), 'utf8')
const launcherColorsPath = join(androidResources, 'values', 'ic_launcher_background.xml')
await mkdir(dirname(launcherColorsPath), { recursive: true })
await writeFile(launcherColorsPath, generatedColors.replace('>#fff<', '>#20342c<'))
