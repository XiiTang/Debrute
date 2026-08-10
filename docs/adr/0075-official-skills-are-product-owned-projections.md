# Official Skills Are Product-Owned Projections

Official `debrute-*` Skills are immutable projections of the selected Debrute
Product. Their directory names are reserved for Debrute, and installation,
update, and repair replace each shipped official Skill with the complete
contents from the current validated Product. Debrute does not detect, merge,
back up, or preserve changes made inside an official Skill directory.

This keeps Runtime, managed CLI, and official Skills on one Product version as
required by [ADR 0006](./0006-product-version-is-runtime-owned.md). Users may
create their own Skills under other names, but customization of official Skill
directories is not a supported product surface.

The direct-child `debrute-*` namespace under `~/.agents/skills` is reserved for
these projections and bounds the mutation scope without an installation
receipt. Materialization removes every entry in that reserved namespace, then
publishes the complete validated current Product Skill inventory. It does not
scan Skill contents for textual markers or mutate any name outside that
namespace. Product removal deletes the same complete reserved namespace.

Publication uses only exact direct-child
`.debrute-projection-<canonical-uuid>` directories as Product-owned transaction
state. Every publication and Product removal first deletes stale directories in
that exact namespace; prefix lookalikes and every other direct child remain
unowned and untouched.
