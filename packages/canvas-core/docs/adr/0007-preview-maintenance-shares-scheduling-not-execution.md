# Preview Maintenance Shares Presentation, Not Source Execution

Canvas preview maintenance uses one spatial priority contract across image,
text, video, and future file types while retaining type-specific canonical
source executors and task registries. Current work is ordered by the squared
distance from the viewport center to the nearest point of each node rectangle.
Distance affects dispatch order only: it does not determine membership, cancel
in-flight work, or create a visibility tier.

Text keeps its DOM-capture registry and Video owns a separate latest-wins
registry. Video source discovery is a bounded pure Probe while source generation
is a single-target Ensure. A canonical task ends when its type-specific source
is confirmed. Width selection, Runtime raster variants and cache, resource-start
scheduling, mounted pending DOM, decode, failure, retry, and visible publication
then enter one shared Raster Preview Presentation pipeline.

That shared pipeline uses one identity hierarchy. A Source Revision identifies
authoritative Project bytes, while uncommitted text uses a local content digest.
Each type-specific producer turns the applicable content identity and its
pixel-affecting target inputs into a Preview Target Identity; a producer-owned
Canonical Preview Source Identity may complete the materialized source.
Requested width then produces a Preview Variant Identity. Project ID, Canvas ID,
and Project Path scope resource keys but are not pixel identity, while retry
attempts are neither source nor variant identity.

One Preview Continuity Key states whether already-mounted pixels may remain
visible while another width loads. Image continuity is revision-bound, Text
continuity uses the complete Text Preview Target Identity, and Video continuity
adds the Runtime-owned Canonical Preview Source Identity. A continuity change
rejects old DOM immediately; a width-only change retains the old visible layer.

The shared Workbench presentation mounts the requested variant as a real hidden
`<img>`, waits for load or cached completion and `decode()`, and promotes that
same DOM element only while its continuity and variant identities remain
current. It uses the common start and publication scheduler, preserves a valid
visible layer on replacement failure, and retries only explicitly. It has no
off-DOM preloader, media-specific presentation reducer, fixed settle timeout,
or animation-frame paint proxy.

This accepts two type-specific maintenance registries and type-specific protocol
operations in exchange for preserving each source producer's real lifecycle.
Reusing the Text registry or introducing one generic Preview Task Registry would
either expose irrelevant Text states to other media or hide meaningful
source-generation transitions behind generic names. Sharing identity-derived
width selection and mounted presentation while keeping canonical producers
separate makes cross-media behavior identical without coupling their source
execution lifecycles.
