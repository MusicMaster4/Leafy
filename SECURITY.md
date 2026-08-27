# Security policy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose financial data, API keys, or pairing secrets. Use GitHub's private vulnerability reporting for this repository instead.

Include the affected version, platform, reproduction steps, and the smallest safe proof of concept. Do not attach real financial records or active credentials.

## Scope

The most sensitive surfaces are local data storage, QR pairing, the local sync endpoint, OpenRouter key handling, and release artifacts. Leafy currently keeps an OpenRouter key in process memory for the app session. It is not persisted or synced.
