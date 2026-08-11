# Runtime Owns Product Removal

Product removal is one Runtime-owned transaction. The Workbench frontend,
whether hosted by Desktop or a browser, the managed CLI, and the Windows native
uninstaller are initiating surfaces only. They collect the confirmed
preservation choice and request the same Product-removal capability; none owns
file deletion, process discovery, or a separate cleanup policy.

The Runtime `product` subsystem owns a `ProductRemovalCoordinator` beside the
Product installation and update commit coordinators. Removal shares the
`ProductStore` transaction lock, Runtime lifecycle admission and work draining,
the closed Product-owned namespaces, and platform adapters. It does not reuse
the Product-update commit state machine: update advances a validated Product to
Ready, while removal irreversibly retires the installed Product.

Before installed executable paths are changed, the coordinator validates the
current Product and platform registrations, resolves the exact closed
Product-owned paths and identifiers, durably records that one-shot removal
transaction, stages any explicitly retained configuration outside the deletion
root, and copies the manifest-validated current Runtime execution closure into
a private operating-system temporary directory. On macOS that closure is the
complete Runtime application bundle; on Windows it is the Runtime directory
with every manifest-declared adjacent dependency. It starts that copy in one
internal `finalize-product-removal` mode and then enters the Product-removal
lifecycle transition. The temporary Runtime waits for the originating Runtime
to release Product state; platform deletion retries cover the short tail of
Desktop, CLI, and native-uninstaller process exit as applicable. It executes
only the resolved removal transaction, restores the two permitted configuration
files when requested, and removes its private transaction and temporary
artifacts.

Removal admission and removal completion are distinct. A successful Control
response means that the detached finalizer has started; the CLI reports that
request as accepted and Workbench reports that removal is finishing. Neither is
a completion receipt. The finalizer removes every non-Desktop installed Product
surface, restores explicitly retained configuration, and disposes the private
transaction before it removes the registered Desktop location. On macOS it also
physically removes the temporary Runtime capsule at that boundary. Windows
cannot remove the finalizer executable while it is mapped, so the finalizer must
successfully register every capsule entry with the operating system for deletion
at the next restart. A registration failure prevents Desktop removal. The
capsule is temporary execution state rather than an installed Product surface,
so Desktop remains the final installed completion boundary. The Windows native
uninstaller waits for that location to disappear and reports failure if the
boundary is not reached; Debrute does not add a second cleanup helper, permanent
removal receipt, or recovery state machine solely to report the same transition.

The temporary copy is an execution phase of the same Runtime, not a second
Product authority. Debrute installs no standalone removal helper, cleanup
daemon, or permanent platform script. The finalization mode accepts no
arbitrary deletion roots and cannot expand the resolved Product-owned scope.
Platform-specific process waiting, native registration removal, and final
temporary-file disposal remain adapter details. On Windows that native
registration boundary includes the fixed current-user Apps & Features keys,
Start Menu shortcut, and installer cache written by NSIS. A macOS Finder drag
to Trash does not execute Debrute and therefore cannot start this transaction.
