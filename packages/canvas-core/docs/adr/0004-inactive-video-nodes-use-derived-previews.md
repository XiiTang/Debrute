# Inactive Video Nodes Use Derived Previews

Inactive Canvas video nodes use revisioned still previews while selected,
requested, or playing nodes own real browser players; Playback Position is
persisted only at playback boundaries so the inactive preview and a remounted
player resume from the same frame. Readiness-driven, node-local handoff keeps
the current layer visible until its target can display, then releases the old
layer. This trades a frame-extraction and width-variant cache for bounded player
and media-control residency on large Canvases, instead of keeping every visible
video as a live player or switching through a blank frame.
