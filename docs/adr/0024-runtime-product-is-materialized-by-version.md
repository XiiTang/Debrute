# Runtime Product Is Materialized By Version

Each complete Runtime Product version is installed under the current user's
Debrute product root and contains the Rust Runtime, Web assets, managed CLI,
official Skills, model documentation, native workers, and one strict product
manifest. A stable `current` symlink on macOS or managed junction on Windows
selects the active version. Product Installers carry the same version as an
embedded Product seed, but the active Runtime never runs from the Electron
application directory; Product installation invokes Rust-owned logic to
materialize and activate an exact product version. This was chosen over running
Runtime inside the Desktop bundle so Desktop location and replacement do not
determine Runtime, CLI, or login-start lifetime, and updates can stage a
complete version before changing the active pointer.

Update releases therefore include a complete Product archive beside each
supported macOS/Windows Product Installer. Runtime authenticates both through
the same signed release manifest, fully materializes the archive before
starting the commit, installs Desktop first, advances `current` second, and
retires the previous version only after the target Runtime is Ready.
