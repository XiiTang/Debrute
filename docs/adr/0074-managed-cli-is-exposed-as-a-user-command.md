# Managed CLI Is Exposed As A User Command

Installing the Debrute Product makes `debrute` resolvable by command name in
new user terminals and new Agent processes on macOS and Windows. The managed
CLI remains part of the one Product version established by
[ADR 0006](./0006-product-version-is-runtime-owned.md); there is no independent
npm package, CLI installer, update stream, or version selection.

The authoritative CLI entrypoint remains under `~/.debrute/bin` and resolves
the Runtime selected by the Product's stable `current` path. On macOS, the
installation adapter adds that directory through exact, bounded Debrute blocks
in the detected user's applicable shell startup files. On Windows, it adds the
same user-relative directory to the current user's `PATH` registry value.
Neither adapter requests administrator access or writes into `/usr/local/bin`,
Homebrew directories, or another system-wide command directory.

Installation verifies that a fresh command environment resolves `debrute` to
the installed Product before reporting success. Shell-file writes preserve
existing links, permissions, and unrelated content.

Atomic shell-file replacement uses only exact direct-child
`.debrute-shell-<canonical-uuid>` temporary files beside the resolved startup
file. Installation, repair, and removal delete stale entries in that exact
transaction namespace; prefix lookalikes and all other neighboring files remain
unowned and untouched.

PATH propagation is not an immediate-process guarantee. Official Skills retain
the stable Product CLI path as a fallback when the invoking Agent predates the
installation or does not inherit user shell configuration. That fallback may
not select another `debrute` from PATH or an independently installed version.

Product installation and repair remove complete Debrute-delimited blocks from
the bounded set of supported shell startup files before projecting the current
login shell, so changing shells cannot accumulate stale Debrute exposure.
Product removal deletes the managed CLI and removes only that same closed
command-exposure namespace from every supported shell file, or the exact
normalized `~/.debrute/bin` entry in Windows User `PATH`. It never deletes a
startup file, an unrelated block, or another PATH entry.
