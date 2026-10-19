# Pentagon Marketing RC1: encrypted whitelist backup and isolated recovery drill

**Scope:** Marketing preview Railway staging only. No Pentagon production DB, auth, DNS, Replit, provider-node or scheduler changes.

## Threat model and protection

- Whitelist requests and reviewer audit activity live in a dedicated Railway staging volume as requests.jsonl and review-audit.jsonl, never in the Pentagon public schema.
- An existing reviewer session with the unchanged passphrase, correct Origin and valid CSRF token is required for POST /api/whitelist-review/backup.
- Reviewer supplies an RSA-3072 public key. Staging assembles a consistent synchronous snapshot, validates rows, checks size and SHA-256 for each file, encrypts the package with a random AES-256-GCM key, and wraps it using RSA-OAEP-SHA256.
- Railway never receives the recipient private key or decryption passphrase. The encrypted response contains no readable email or reviewer audit text, and never grants Pentagon account access.
- The TRADEVICEPC client creates an encrypted PKCS#8 private key and separate randomly generated backup passphrase, protected by Windows user-scoped DPAPI. It reads the current reviewer secret from the already-protected Windows local store only for authentication, without rotating or printing that secret.
- The client downloads the ciphertext via authenticated TLS, verifies complete in-memory decryption and SHA-256 parity, writes only the encrypted envelope in a separate private local directory, then logs out.
- Recovery is offline-only and refuses to overwrite an existing directory or Railway production files. Tampered ciphertext, wrong recipient, bad timestamp, bad digest, malformed JSONL, oversized files, and unexpected file paths fail closed.
- All CI tests use mock .example.test addresses, short-lived RSA test keys, and temporary folders.
- No automatic backup cron or unapproved offsite export is enabled.

## Owner-operated backup and verification

The following scripts are deployed separately to the authorized TRADEVICEPC working directory by the engineering workflow, never copied into the running Railway application:

C:\Users\MARKSTUDIOS\Pentagon-Migration-Audit\scripts\marketingWhitelistBackup.js

C:\Users\MARKSTUDIOS\Pentagon-Migration-Audit\scripts\Backup-Pentagon-Marketing-Whitelist.cjs

C:\Users\MARKSTUDIOS\Pentagon-Migration-Audit\scripts\Verify-Pentagon-Marketing-Whitelist-Backup.cjs

Run in a private PowerShell console:

    node 'C:\Users\MARKSTUDIOS\Pentagon-Migration-Audit\scripts\Backup-Pentagon-Marketing-Whitelist.cjs'

The first run generates the RSA recipient key pair and protects its private key and passphrase under:

    %USERPROFILE%\Pentagon-Secure-Backups\Pentagon-Marketing-Whitelist-Backup\

Successful output reports STAGING_WHITELIST_ENCRYPTED_BACKUP=PASS, the local encrypted archive path, encrypted SHA-256, record counts and ROUNDTRIP_DECRYPT_CHECKSUM=PASS. Do not paste reviewer passwords, backup passphrases, private keys, CSV data or unencrypted lead records into chat or GitHub.

To recheck an encrypted archive without writing PII:

    node 'C:\Users\MARKSTUDIOS\Pentagon-Migration-Audit\scripts\Verify-Pentagon-Marketing-Whitelist-Backup.cjs' '<absolute path to .encrypted.json>'

For an explicit offline-only recovery, select a NEW, non-existing child folder beneath Pentagon-Marketing-Whitelist-Backup\Offline-Recovery:

    node 'C:\Users\MARKSTUDIOS\Pentagon-Migration-Audit\scripts\Verify-Pentagon-Marketing-Whitelist-Backup.cjs' '<encrypted archive path>' --restore-offline '<NEW LOCAL recovery directory>'

That optional restore creates plaintext leads exclusively on the authorized Windows PC. Apply retention controls and remove the recovered plaintext securely after the disaster-recovery drill. There is no endpoint to write recovered records to Railway.

## Remaining public-launch blockers

1. **Offsite independence: OPEN.** An encrypted local TRADEVICEPC backup is independent of the Railway volume, but it is not a geographically separate/offsite archive. Arrange approved restricted storage, and verify its independent download SHA before public launch.
2. **Disaster recovery portability: OPEN.** The DPAPI backup-key passphrase only unlocks under the original Windows user context. Secure escrow/recovery for a lost TRADEVICEPC is required before production.
3. **Deletion versus historical archives: OPEN.** A backup may retain emails later deleted from live staging. Approve backup expiry and data-subject deletion procedure.
4. **Scale: OPEN.** This single-process file-backed staging storage is not a multi-replica production database.
5. **Capacity:** Fail-closed per-file 2 MiB limit and 10,000-record bound.
6. **Operations:** Appoint an authorized backup owner, retention schedule, restore approver and key rotation owner.

## Release gate

- Required: synthetic encrypted backup, tamper detection and byte-exact offline restore PASS in GitHub CI.
- Required: live staging encrypted snapshot saved on TRADEVICEPC and verified in memory, without exposing emails in logs.
- Replit landing and reviewer passphrase remain unchanged.
- PR #27 must remain Draft. Pentagon production and DNS must remain untouched.
- **PUBLIC MARKETING RELEASE: NO-GO** until demo domain, claims, pricing, privacy, production whitelist routing, offsite recovery, and explicit owner final GO.
