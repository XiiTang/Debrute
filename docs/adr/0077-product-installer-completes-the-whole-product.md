# Product Installer Completes The Whole Product

Debrute's user-facing Product Installer completes the whole Product before it
reports installation success. Desktop is one installed Product component; it
does not own installation and its first launch is never an installation
trigger. The installer may offer to launch Desktop only after the complete
Product has been installed and verified.

Windows uses the customized NSIS installer as its Product Installer. On macOS,
the DMG is a distribution container for a user-space Debrute Product Setup; a
drag-only application copy is not the complete Product installation flow.
These are platform-specific surfaces over the same Rust-owned internal
`install-product` capability, rather than independent installation
implementations.

The macOS DMG exposes one user action: `Install Debrute.app`. It does not
expose a draggable `Debrute.app` or an Applications-folder alias, because
copying Desktop alone would create an incomplete Product. The Setup is a thin
signed host for the same Rust installation capability and carries the complete
Product payload exactly once. It installs Desktop into `~/Applications`,
converges and verifies the remaining Product, and only then offers to launch
Debrute.

The whole Product is installed for the current operating-system user and does
not require elevation. The macOS Product Setup installs Desktop at
`~/Applications/Debrute.app`; the Windows Product Installer installs Desktop
at `%LOCALAPPDATA%\Programs\Debrute`. Runtime Product state, command exposure,
login-start registration, Electron state, and official Skills belong to that
same user. Fresh installation leaves Start at Login disabled. Repair and update
preserve an existing exact registration because it names the stable Runtime
entrypoint; uninstall always removes the exact Debrute registration. Per-user
ownership does not put every component under one directory:
official Skills continue to use the agent ecosystem's shared
`~/.agents/skills/debrute-*` namespace defined by
[ADR 0075](./0075-official-skills-are-product-owned-projections.md), while
Debrute-owned Runtime and configuration state remains under `~/.debrute`.

Repeated Product Installer runs follow the selected Product version rather
than a separate installer version state. With no installed Product, the
installer performs the initial complete installation. With the same version,
it idempotently repairs every Product-owned projection. When its embedded
Product is newer, it uses the existing whole-Product update transaction and
pending commit defined by
[ADR 0025](./0025-product-update-commits-desktop-before-current.md). When the
installed Product is newer, preflight rejects the downgrade before mutating
any installed component. The Windows installer performs this version preflight
from `customInit`, then asks the installed Runtime to commit Product Quit and
waits for its Control ownership to disappear before NSIS extracts application
files. macOS Product Setup performs the same Runtime stop cut and additionally
waits for Desktop processes before replacing the application. The later Rust
seed preflight still authenticates the complete installed payload.

Each Product Installer carries Desktop together with one complete,
manifest-validated Product seed. It places Desktop and invokes the embedded
Rust Product installation coordinator to idempotently converge the selected
Runtime Product, managed CLI entrypoint and command exposure, complete official
Skills, and Desktop registration. Installation succeeds only after every
projection succeeds, Runtime is Ready, the Product transaction has settled,
and a fresh command environment resolves `debrute` to the selected Product.

The same published installer remains the update manifest's Desktop asset
without carrying a second Desktop payload. On macOS, Runtime mounts the Setup
DMG and installs only the exact nested
`Install Debrute.app/Contents/Resources/Debrute.app`. On Windows, Runtime invokes
NSIS with the exact pending transaction id. The installed Runtime validates the
ID against the durable staged record without competing for its parent Runtime's
transaction lock; NSIS's old-version uninstaller removes only Desktop in this
update mode. NSIS then skips its ordinary whole-Product completion hook,
allowing the already-running Rust update coordinator to continue the one
transaction after NSIS returns.

Installation does not download a mutable source checkout, language
environment, dependency graph, or remote installation script. It also does not
create a permanent installation receipt or a second `applying`/`ready` state
machine. Product selection and interrupted update recovery remain owned by the
existing `ProductStore` current and pending-commit records. An interrupted or
partial installation is repaired by running the same idempotent Product
Installer convergence again.

The closed ownership boundary is the Debrute home, the direct-child
`debrute-*` Skill namespace and exact
`.debrute-projection-<canonical-uuid>` Skill transaction namespace, exact
Debrute-delimited shell blocks and exact sibling
`.debrute-shell-<canonical-uuid>` transaction files or the exact Windows User
PATH entry, exact login-start identifiers, registered Desktop location, fixed
Windows installer registration, shortcut and cache, and fixed Electron
user-data and log roots. Product removal resolves
a one-shot deletion plan from those identifiers and current platform
registrations; it does not need mutation history, scan arbitrary user content,
or retain a permanent inventory solely for later uninstall.
