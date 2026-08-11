---
status: superseded by ADR-0079
---

# Canvas Video Production Uses Product-Owned FFmpeg

Media Chrome owns customizable controls around the active browser player; it does not own video metadata, still-frame production, or Feedback source pixels. Inactive Canvas video nodes continue to use Runtime-derived previews, so every supported Product carries pinned, manifest-verified `ffmpeg` and `ffprobe` executables for its platform and architecture. The Runtime video producer invokes only those Product-owned executables, without resolving a system `PATH` version or falling back to a user-installed copy.

This was chosen over mounting browser players for inactive nodes or moving frame capture into Workbench because Runtime production preserves revision binding, cancellation, shared preview caching, and Feedback generation independently of one client. FFmpeg is therefore a private Canvas video dependency rather than a catalog Integration: Debrute does not expose it through a recommendation directory or manage its external installation, update, or removal.
