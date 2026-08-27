# Security policy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose financial data, API keys, or pairing secrets. Use GitHub's private vulnerability reporting for this repository instead.

Include the affected version, platform, reproduction steps, and the smallest safe proof of concept. Do not attach real financial records or active credentials.

## Scope

The most sensitive surfaces are local data storage, QR pairing, the local sync endpoint, OpenRouter key handling, and release artifacts. Leafy keeps an OpenRouter key in process memory for the app session. It is not persisted or synced.

## Security model

- Ledger records and saved pairing credentials are sealed locally with AES-256-GCM. The device key is non-exportable and stored by the platform WebView in IndexedDB.
- Sync payloads are separately encrypted with a random 256-bit AES-GCM key that exists only on the paired devices.
- Local-network transport uses an ephemeral TLS certificate pinned from the QR code. Certificate validation is never disabled.
- A separate random 256-bit token authenticates requests. Sessions expire after one hour, accept only private IP destinations, reject redirects, and cap payloads at 5 MB.
- The desktop sync server never receives the end-to-end encryption key and stores only ciphertext in memory.
- Tauri runs with a restrictive content security policy and the Android app disables cleartext traffic and OS backup.

## Limits

No application can guarantee confidentiality after the operating system, an unlocked device, or the running Leafy process is fully compromised. The pairing QR contains session secrets; anyone who captures it while active may join that session. OpenRouter can read descriptions explicitly submitted for AI categorization, although it never receives amounts or the ledger from Leafy.

Automated checks include npm audit, RustSec, CodeQL for TypeScript and Rust, weekly dependency updates, unit tests, and release-source validation. These checks reduce risk but do not replace responsible disclosure or independent review.
