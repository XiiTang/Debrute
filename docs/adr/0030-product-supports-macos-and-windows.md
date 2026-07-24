# Product Supports macOS And Windows

Debrute Product targets are macOS arm64, macOS x64, and Windows x64. Every
published Desktop installer has a complete matching Runtime Product, participates
in the signed release contract, and passes packaged-product acceptance.

Release-publishing infrastructure may run on another operating system without
making that system a Product target. Product code, platform adapters, manifests,
tests, and documentation implement only the supported macOS and Windows
surfaces. Adding another Product platform requires a new explicit decision and
a complete implementation and acceptance path; it is not introduced through a
placeholder payload or optional release job.

Each native release matrix job builds its own Workbench assets together with
the matching Runtime and Desktop. That build injects one closed `darwin` or
`win32` Workbench constant, so the downloaded Product has already selected its
platform semantics. Workbench does not infer the platform from browser APIs,
receive it again through Runtime bootstrap, or carry Linux and unknown fallback
branches. Source development injects the matching supported host constant;
another host fails the development or build entrypoint.
