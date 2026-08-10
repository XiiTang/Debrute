# Product Removal Is Whole Product

Every Debrute uninstall entry removes the installed Product as one unit:
Desktop, the Runtime-owned materialized Product and stable Runtime entrypoint,
the managed CLI entrypoint, and official managed Skills. Debrute does not offer
a Desktop-only uninstall that leaves Runtime, CLI, or official Skills installed.

This follows the single-version ownership established by
[ADR 0006](./0006-product-version-is-runtime-owned.md). Leaving any executable
surface behind would create an incomplete Product with no reliable Desktop
installation, update, or repair authority. Platform-native uninstallers, the
Workbench frontend, and CLI may require different launch and self-removal
adapters, but they must execute the same Product-removal contract. The
Workbench frontend owns one uninstall experience that is available from both
its Desktop shell and browser surface; Desktop and Browser do not own separate
uninstall flows.

Product removal deletes all Debrute-owned local user state by default. One
explicit, default-off reinstall option may preserve only
`~/.debrute/config/global_settings.json` and
`~/.debrute/config/secrets.json`; its presentation must state that saved API
keys remain on the computer. The removal flow deletes the rest of
`~/.debrute` rather than retaining that directory wholesale. The two retained
files keep their private directory and secret-file permissions when restored.

This user-data choice never changes which executable Product surfaces are
removed. Product removal never deletes Project contents, including
Project-local `.debrute/feedback` or generated artifacts.
