# ADR-0003 — Deezer provider method & local decryption

- **Status:** Accepted
- **Date:** 2026-10-04

## Context

Phase 1 requires one working download flow. The owner directed us to mirror
the method of LuftVerbot/echo-deezer-extension and accepted the legal risk of
using their own Deezer account credentials. Deezer's CDN delivers
`BF_CBC_STRIPE` (Blowfish-CBC stripe) encrypted streams for 320/FLAC tiers,
and the auth endpoint applies bot protection that discriminates TLS
fingerprints.

## Decision

1. **Login chain** (ported from the reference implementation):
   anonymous `gw-light user.getArl` → `sid` cookie →
   `connect.deezer.com/oauth/user_auth.php` (md5 hash chain, app_id 447462) →
   `access_token` → `user.getArl` → **ARL** → `deezer.getUserData` →
   `checkForm|USER_TOKEN` CSRF token + `license_token` + `USER_ID`.
   Session cached in-memory + persisted AES-256-GCM in `provider_credentials`;
   auto-refresh on invalid CSRF; auto-relogin with `.env` credentials.
2. **Transport fallback**: native `fetch` first; the credential exchange is
   retried through a `curl` subprocess because Bun's TLS stack is rejected
   (error 160) while Node/curl pass (fingerprint discrimination, observed
   2026-10).
3. **Media**: `POST media.deezer.com/v1/get_url` with formats ordered by the
   user quality policy (FLAC → MP3_320 → MP3_128). Local Blowfish decryption
   by default (privacy: track ids never leave the machine). Optional external
   resolver (`DEEZER_RESOLVER_URL`) mirrors the reference's secondary path.
4. **Decryption constants (verified against live streams 2026-10)**: key =
   md5-XOR scheme over `md5(trackId)` with secret `g4el58wc0zvf9na1`;
   2048-byte stripes; **every 3rd stripe** (index % 3 === 0) CBC-encrypted
   with the **fixed IV `0001020304050607`** (the historical per-stripe
   `be32(index)` IV no longer applies); remaining stripes are clear.
5. **Quality guardrails** enforced around resolution: skip when an existing
   ISRC/title track is ≥ incoming (hard 24-bit ceiling); configurable floor +
   fallback.

## Consequences

**Positive**

- Full-quality (FLAC/320) downloads with no third-party dependency.
- Credentials used once; only encrypted sessions persist.

**Negative / mitigations**

- ToS violation risk is the owner's (explicitly accepted); documented in README.
- Blowfish lib is GPL-2.0 → isolated in `blowfish.ts` for a clean swap;
  noted in README licensing.
- Deezer can change shapes/constants again → defensive parsing, raw-response
  diagnostics in errors, and unit tests pinning the verified scheme.

## Alternatives considered

- External resolver as primary (echo's `getMediaUrl` path) — leaks track ids
  to a third party, availability risk; kept as optional fallback only.
- ARL-cookie-only auth (deemix style) — avoids the fingerprinted auth
  endpoint but requires manual cookie harvesting; email/password flow was
  the owner's explicit choice. (Adding `DEEZER_ARL` env support remains a
  cheap Phase-2 option.)
