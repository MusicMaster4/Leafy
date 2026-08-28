# Security policy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose financial data, API keys, or pairing secrets. Use GitHub's private vulnerability reporting for this repository instead.

Include the affected version, platform, reproduction steps, and the smallest safe proof of concept. Do not attach real financial records or active credentials.

## Scope

The most sensitive surfaces are local data storage, Android receipt sharing, QR pairing, the private sync endpoint, OpenRouter key handling, and release artifacts. A key entered in Preferences is sealed in local app data and loaded into process memory when Leafy starts. The raw key is never included in pairing data or copied to the phone.

## Security model

- Ledger records, preferences, an optional OpenRouter key, and saved pairing credentials are sealed locally with AES-256-GCM. The device key is non-exportable and stored by the platform WebView in IndexedDB.
- Sync payloads are separately encrypted with a random 256-bit AES-GCM key that exists only on the paired devices.
- Local-network transport uses an ephemeral TLS certificate pinned from the QR code as the client's exclusive trust root. Certificate validation is never disabled.
- A separate random 256-bit token authenticates requests. Sessions expire after one hour, accept only local/private or Tailscale CGNAT destinations, reject redirects, and cap payloads at 5 MB.
- The desktop sync server never receives the end-to-end encryption key and stores only ciphertext in memory. Its ledger endpoint lets the paired phone download and upload authenticated encrypted snapshots so ledger changes can sync in both directions.
- A paired phone can ask the computer to categorize a description over the authenticated, certificate-pinned channel. The computer submits that description to OpenRouter; it never returns the API key to the phone.
- Tauri runs with a restrictive content security policy and the Android app disables cleartext traffic and OS backup.
- Android receipt import accepts only PDF, image, and plain-text share intents. File URIs are rejected in favor of temporary `content://` grants; inputs are capped at 10 MB and 10 PDF pages, decoded in private cache, and deleted after local OCR.
- Imported receipts always require user confirmation. Their full contents are never submitted to OpenRouter, and local rules handle their default category.

## Limits

No application can guarantee confidentiality after the operating system, an unlocked device, or the running Leafy process is fully compromised. A malicious or malformed document may still exploit an unknown vulnerability in Android's PDF renderer or the OCR library; size and page limits reduce, but cannot eliminate, that risk. The pairing QR contains session secrets; anyone who captures it while active may join that session. OpenRouter can read descriptions explicitly submitted through manual entry with `Auto` selected, although it never receives amounts or the ledger from Leafy.

Automated checks include npm audit, RustSec, CodeQL for TypeScript and Rust, weekly dependency updates, unit tests, and release-source validation. These checks reduce risk but do not replace responsible disclosure or independent review.
