# Feedback State Is Structured And Artifacts Are Derived

Canvas Feedback is one Project-scoped current-state document keyed by Project
path; Feedback Marks and Feedback Items are its durable meaning, while annotated
image and video-moment PNGs are asynchronously materialized derivatives that
Workbench never reads back as state. This was chosen over embedding review data
in individual Canvas Documents or treating rendered images as editable truth so
feedback is shared across Canvas views, remains directly intelligible to Agents,
and can survive artifact failure without losing accepted intent. The trade-off
is strict structured validation plus a latest-only artifact scheduler and
diagnostics for derived-output failures.
