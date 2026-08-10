# Preview Quality Settlement Is Independent of Camera Idle

Canvas restores hit testing, Hover, Feedback, and final viewport publication
after the short camera-interaction idle boundary, but adopts the latest camera
scale for Preview Variant selection only after a separate 160 ms Preview
Quality Settlement with no intervening camera update. This Canvas-wide boundary
replaces per-node or per-media resource debounces, does no work for a pure pan
or a return to the current resource zoom, and preserves the visible preview
until the one final requested variant is decoded and published. The short idle
boundary can recur between events in one wheel or trackpad gesture, so using it
for both interaction recovery and preview quality caused repeated cross-media
request, decode, and publication work. Preview Quality Settlement is upstream
of Raster Preview Presentation and does not alter ADR 0007's rejection of a
presentation-owned fixed settle timeout.
