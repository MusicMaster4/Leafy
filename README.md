<div align="center">
  <img src="src-tauri/icons/app-icon.svg" width="92" alt="Leafy icon" />
  <h1>Leafy</h1>
  <p>A calm, local-first way to understand your money.</p>

  [![CI](https://github.com/MusicMaster4/Leafy/actions/workflows/ci.yml/badge.svg)](https://github.com/MusicMaster4/Leafy/actions/workflows/ci.yml)
  [![Release](https://github.com/MusicMaster4/Leafy/actions/workflows/release.yml/badge.svg)](https://github.com/MusicMaster4/Leafy/releases)
  [![Security](https://github.com/MusicMaster4/Leafy/actions/workflows/security.yml/badge.svg)](https://github.com/MusicMaster4/Leafy/actions/workflows/security.yml)
  ![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)
  ![React 19](https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white)
</div>

![Leafy desktop dashboard](docs/screenshots/leafy-dashboard.png)

Leafy is a personal finance tracker for people who stop using finance trackers. Adding an expense takes a value, a short description, and one click. The dashboard does the rest.

Your ledger lives on your device. There is no Leafy account and no shared database. Local records are sealed with AES-256-GCM, while phone-to-computer sync combines end-to-end encryption with a short-lived, certificate-pinned TLS session.

## What works today

- One-step income and expense entry, also available with the `N` shortcut
- Balance, income, expenses, savings rate, and seven-day spending pace
- Line, bar, and category donut charts with 7, 30, and 90-day views
- Optional AI categorization through your own OpenRouter key
- Offline category matching when AI is unavailable
- Private desktop-to-phone pairing by QR code
- Responsive desktop and Android interface
- Stable releases from `main` and beta releases from `testing`

<table>
  <tr>
    <td width="68%"><img src="docs/screenshots/leafy-dashboard.png" alt="Leafy dashboard with fictional finance data" /></td>
    <td width="32%"><img src="docs/screenshots/leafy-mobile-entry.png" alt="Leafy quick expense entry on mobile" /></td>
  </tr>
</table>

The screenshots use generated demo transactions. They contain no bank exports, API keys, pairing secrets, or personal financial data.

## Run Leafy

You need Node.js 22 or newer. Desktop and Android builds also need the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
npm install
npm run dev
```

Open `http://localhost:1420` for the browser version.

Run the desktop app:

```bash
npm run tauri dev
```

Build an Android APK:

```bash
npm run tauri android init
npm run tauri android build -- --apk
```

## AI categorization

`Auto` is the default category. Leafy sends the transaction description to OpenRouter and accepts only one of the categories defined by the app. If the request fails or no key is configured, a small local ruleset makes the choice instead. Saving the transaction never depends on the network.

Connect a key from Preferences for the current app session, or provide it before launch:

```powershell
$env:OPENROUTER_API_KEY="sk-or-v1-..."
npm run tauri dev
```

The key is not written to the repository, paired to another device, or included in screenshots. You can choose a different OpenRouter model with `LEAFY_OPENROUTER_MODEL`. The default is `openrouter/auto`.

## Private device sync

The desktop app starts a one-hour HTTPS endpoint on a random port in your local network. Its self-signed certificate is pinned directly from the QR code, so Leafy never disables certificate or hostname verification. The QR carries independent secrets for transport authentication and content encryption:

- a 256-bit AES-GCM key used before financial data leaves the device
- a separate 256-bit bearer token compared in constant time
- the ephemeral TLS certificate and a random session identifier

The encryption key is never sent in a network request. The native client accepts only `https://` endpoints on private IP addresses, rejects redirects and public hosts, caps payload size, and binds ciphertext to its session with authenticated additional data. Pairing details and the ledger are encrypted locally with a non-exportable device key. Legacy plaintext storage is removed after a successful migration.

## Release channels

| Branch | Channel | Version shape | GitHub release |
| --- | --- | --- | --- |
| `main` | Stable | `v0.1.0` | Latest release |
| `testing` | Beta | `v0.1.1-testing.1` | Pre-release |

Only these branches publish builds. Every release includes Windows, macOS, Linux, and an installable Android APK. Pull requests and other branches run type checks, tests, the production web build, and a native Rust check without publishing anything.

## Checks

```bash
npm test
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo check --locked --manifest-path src-tauri/Cargo.toml
```

## Project map

```text
src/                    React interface, charts, finance logic, sync crypto
src-tauri/src/          Tauri commands, OpenRouter client, local sync server
src-tauri/gen/android/  Generated Android Studio project
scripts/                Branch-aware release versioning
.github/workflows/      CI and stable/beta release pipelines
```

## Privacy notes

Leafy does not connect to banks and does not upload a ledger to a Leafy service. OpenRouter receives only descriptions that you submit with `Auto` selected. Someone who can unlock or fully compromise your device can still access data the app can access, and anyone who photographs an active pairing QR can join that time-limited session. Treat the QR like a password and disconnect the device when you are done. See [SECURITY.md](SECURITY.md) for the threat model and private reporting process.

## Contributing

Bug reports and focused pull requests are welcome. Run the three checks above before opening a PR. Please do not include real bank statements, API keys, or screenshots with personal data in issues.

Built with [Tauri](https://tauri.app/), [React](https://react.dev/), [Recharts](https://recharts.org/), and [OpenRouter](https://openrouter.ai/).
