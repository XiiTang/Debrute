# Signed Manifest Authenticates Product Updates

Debrute treats GitHub Releases only as the host for update bytes: the runtime
trusts an update version, URL, size, and hash only after verifying the exact
release manifest bytes with the embedded Ed25519 public key. This was chosen over
trusting GitHub metadata, Electron updater metadata, or a plain checksum file so
the replacement helper receives one platform asset whose origin and integrity
were authenticated before installation.
