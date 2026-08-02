# Preview Maintenance Shares Scheduling, Not Execution

Canvas preview maintenance uses one spatial priority contract across image,
text, video, and future file types while retaining type-specific executors and
task registries. Current work is ordered by the squared distance from the
viewport center to the nearest point of each node rectangle. Distance affects
dispatch order only: it does not determine membership, cancel in-flight work,
or create a visibility tier.

Text keeps its DOM-capture registry and Video owns a separate latest-wins
registry. Video source discovery is a bounded pure Probe while source generation
is a single-target Ensure. A canonical task ends when its type-specific source
is confirmed; width variants, resource loading, and mounted handoff remain in
the shared presentation pipeline.

This accepts two small state machines and type-specific protocol operations in
exchange for preserving each source producer's real lifecycle. Reusing the Text
registry or introducing one generic Preview Task Registry would either expose
irrelevant Text states to other media or hide meaningful source-generation
transitions behind generic names. Sharing only the scheduling, interaction,
stale-result, and presentation primitives keeps those cross-type policies
consistent without coupling executor evolution.
