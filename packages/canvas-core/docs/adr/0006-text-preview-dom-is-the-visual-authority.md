# Text Preview DOM Is The Visual Authority

Canvas text preview source generation uses one serialized hidden read-only
CodeMirror editor. For the current job, Workbench incrementally rebuilds the
rendered editor from shallow element clones and Unicode-safe text chunks,
copies an explicit allowlist of pixel-affecting computed styles, and serializes
the clone as XML parts in bounded animation-frame slices. It removes
interactive-only layers and unsafe attributes, materializes the persisted Text
Viewport into clone-stable transforms, and asynchronously converts the SVG Blob
to a self-contained data URL. The snapshot embeds the active managed subset
faces, decodes one SVG `foreignObject`, draws it once to an adaptive-size
`OffscreenCanvas`, and encodes the canonical PNG.

Canonical work is owned by one real-time latest-wins registry, not frozen
cohorts. Every stable missing-or-stale text target is admitted regardless of
viewport. At each job boundary the squared distance from the viewport center
to the nearest point of each node rectangle chooses the next work, with Project
path as an exact tie-breaker. Canvas
interaction gates new dispatch without changing membership. The canonical
text geometry is derived once from node geometry, the fixed 10x presentation
scale, and the 32px titlebar; live presentation and hidden capture consume the
same result. Mounted DOM size is only a development consistency assertion.

Runtime-projected full-file SHA-256 and text language allow Workbench to compute
the target and query canonical-source availability before reading the file
body. Cache hits skip body reads, font work, and capture. Missing targets use a
rolling 10-target, 8 MiB content-materialization view with at most two reads in
flight. Preview-private content is released after capture and never inserted
into the editor buffer store.

One Project-generation font session owns one active memory-only subset bundle
and at most one candidate. Within a non-empty work epoch coverage grows; each
candidate is rebuilt from the full original primary and managed fallback faces.
The current active bundle may serve covered DOM captures while the short-lived
font Worker builds the next candidate. Candidate activation is atomic at a
capture boundary, after which the old faces are removed. When the registry
empties the accumulated coverage resets, while an already sufficient active
bundle may be reused by the next epoch. Font packages are not persisted or
shared across Projects.

The source scale is bounded by 4x, 4096 pixels on either axis, and 8,388,608
pixels total. Exactly one source capture owns the hidden CodeMirror DOM at a
time. Source uploads retain the current asynchronous concurrency behavior and
may overlap later captures; Runtime-confirmed save or an already matching
`source.png` is the canonical completion authority. Width variants and mounted
image decoding are a separate presentation pipeline. The shared spatial
priority orders that work without deciding its membership, and it does not keep
canonical work active. Preview maintenance shares this priority contract rather
than one executor, as recorded in
[`0007-preview-maintenance-shares-scheduling-not-execution.md`](./0007-preview-maintenance-shares-scheduling-not-execution.md).

The captured DOM is the sole visual authority. There is no parallel
drawing-command scene, text-specific renderer, raster Worker, compatibility
path, or fallback. This accepts main-renderer DOM/style-copy, SVG decode, draw,
and PNG-encode work in exchange for eliminating a second text layout and syntax
rendering implementation. The font Worker is preprocessing rather than a
second renderer: it changes font byte coverage but does not decide text layout
or pixels. Typed failures remain visible instead of silently publishing a
different visual result.
