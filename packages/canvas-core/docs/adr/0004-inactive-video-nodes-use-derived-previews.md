# Inactive Video Nodes Use Derived Previews

Inactive Canvas video nodes use revisioned still previews while content-active,
requested, or playing nodes own real browser players; Playback Position is
not persisted and no preview is produced merely because playback pauses. When
a player is both not playing and content-inactive, unloading captures and
persists its exact current timestamp, produces the matching preview, and removes
the player only after that preview can display. A remounted player starts from
the same Playback Position. If persisting the captured position fails, that
unload is cancelled while the same mounted player retains its current timestamp;
the player is not rolled back to the previously persisted position. If the
matching preview cannot be produced or displayed, unloading is likewise
cancelled and the player remains mounted; an older preview cannot replace it.
Readiness-driven, node-local handoff keeps the current layer visible until its
target can display, then releases the old layer. This trades a frame-extraction
and width-variant cache for bounded player and media-control residency on large
Canvases, instead of keeping every visible video as a live player or switching
through a blank frame.
