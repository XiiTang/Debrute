# Canvas Map Is Source Intent

Each Canvas has two deliberately different Project Documents. Its Canvas Map
YAML is editable source intent for file membership and automatic comparison
rows; its matching Canvas JSON is the pushed visual state used by the product.
Pushing expands the map against current visible Project files, derives required
directory nodes, and reconciles the result into JSON while preserving surviving
manual rectangles and stack order.

This was chosen over storing source rules and visual state in one document, or
treating rendered Canvas state as the editable membership source. The split
keeps Agent-authored intent compact and reviewable while allowing direct visual
edits to persist without rewriting YAML. It also means file hierarchy,
availability, selection, camera, and drag previews are derived or transient
state rather than duplicated document fields.
