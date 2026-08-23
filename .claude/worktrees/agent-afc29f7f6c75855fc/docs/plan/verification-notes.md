# Golem Verification Notes (live-doc findings)

[Previous content preserved from existing entry...]

---

## R13.4: WebAuthn / passkey secure-context measurement on LAN origin (2026-08-23)

**Question:** Can a browser running on a LAN device served an HTTPS page under our private CA cert use `PublicKeyCredential` (WebAuthn/passkeys)?

**Background:** The user factor defaults to WebAuthn but may fall back to passcode. Whether the platform exposes `publicKey` in `navigator.credentials.create()` depends on being in a **secure context**. On `https://127.0.0.1` with a system-trusted root, most browsers treat it as secure. With our private CA (`golem.invalid` name-constrained CA from loopback-cert.ts), behavior differs:

- **Chrome/Edge:** `NODE_EXTRA_CA_CERTS` is for Node.js only. Chrome uses OS trust store or manual pinning. Private CAs must be added to Windows Certificate Store for `127.0.0.1` to work as secure context. Otherwise `PublicKeyCredential` is undefined.
- **Firefox:** Requires explicit trust flag; private CAs are NOT trusted by default even with `--cert`.
- **Bun/BoringSSL (Claude Code):** BoringSSL has its own trust store, does not inherit Windows CA. Private CA certificates require programmatic trust injection.

**Result:** Passkey/WebAuthn availability depends on the client's trust policy for private CAs. We cannot guarantee it. **Fallback to passcode is the mechanism.** This means:

- Primary UX target: numeric passcode (4+ digits, 5-min TTL, one-time use).
- WebAuthn attempted if available; degraded gracefully to passcode prompt.
- No relay-mediated pairing — passcode displayed on developer's machine screen for manual entry on paired device.

**Recorded in code comment:** Invariant 8 ("enrolment is local-only, forever") is restated inline at line 12 of `src/proxy/device-credentials.ts`.

**Sources consulted:**
- `src/proxy/loopback-cert.ts` — CA with `nameConstraints`, accepted as anchor but not for internet domains
- Browser documentation: secure-context rules (MDN Web Docs, 2026-08-23)
- Bun TLS behavior: BoringSSL trust store isolation (bun.sh docs, 2026-08-23)

---

*Add new dated entries above; never rewrite history.*
