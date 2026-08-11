---
status: accepted
---

# Workbench Browser Owns Canvas Video Decoding And Frame Capture

The Workbench browser engine owns Canvas video decoding, intrinsic metadata,
playback, and still-frame capture. Debrute does not carry a second
video decoder, preflight codec support with `canPlayType()`, or promise that a
recognized container candidate is decodable on every host. The actual browser
decode result is the authority used by both the player and preview producer.

Workbench maintains one bounded, serialized hidden capture lane. For each exact
Source Revision and playback or Feedback Moment time it loads the Runtime's
revisioned raw URL, waits for browser metadata and the requested frame, draws a
bounded PNG, and submits that source to Runtime. Runtime remains the authority
for Project path confinement, exact source leases, byte-range delivery, MIME
mapping, capture validation, atomic cache files, raster width variants, and
Feedback Artifact publication. The Feedback scheduler retains an exact missing
frame as pending derived work and resumes it directly when that browser capture
is saved, without manufacturing a Project revision. Without an open Workbench
it stays pending until a later Workbench can capture it. Runtime publishes a
lightweight maintenance descriptor for every known video with a persisted
Feedback Moment even when its directory is collapsed; Workbench sends that
descriptor through the same source-resolution and capture lanes without making
the hidden video a Canvas node or adding a playback target.

This is the sole exception to ADR-0069 and Canvas ADR-0007's ordinary rule that
Folder Disclosure determines source-maintenance membership. Runtime authorizes
only exact current Feedback-video paths, and hidden resolution omits
player-specific companion text-track work. A failed hidden target creates no
Activity or automatic retry in its current registry; a new Workbench, changed
source or Moment, or redisclosure creates a new attempt. Redisclosure retries
before the failure can become visible player state.

This replaces ADR-0078. A Product-owned FFmpeg path duplicated the decoder used
for playback, expanded build, signing, release, licensing, and attack-surface
contracts, and still could disagree with the pixels the browser actually shows.
Using the existing browser decoder gives one host capability boundary and lets
Runtime retain all privileged filesystem and cache responsibilities. Product
manifest schema 3 therefore has no Canvas video runtime-dependency declaration,
and Debrute has no FFmpeg payload, build job, source archive, or fallback to a
system installation.
