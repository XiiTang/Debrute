# Linux Is Best-Effort Distribution Only

Debrute formally supports macOS and Windows. A Linux artifact may be published
when the shared implementation and release pipeline produce it without
Linux-specific product work, but its presence is convenience distribution, not
a compatibility or availability promise. Architecture, feature design,
implementation branches, platform adapters, tests, release acceptance, and bug
fixes do not account for Linux unless a later explicit decision changes the
support boundary. Linux artifact failure therefore cannot block a macOS or
Windows release. This was chosen over nominal three-platform support because an
untested target would impose hidden constraints on every lifecycle and update
decision without providing a product-quality Linux experience.
