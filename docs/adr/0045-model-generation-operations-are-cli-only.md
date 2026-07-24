# Model Generation Operations Are CLI Only

Only a CLI session may reserve, start, observe, or cancel model-generation
Operations. The five peer generation kinds are image, video, text-to-speech,
music, and sound effect. `audio` is only a configuration and implementation
grouping for the latter three, while the current image-batch command is an
execution form of image generation rather than a sixth generation kind.
Browser, Desktop-host, native control, and Photoshop Bridge sessions receive no
model-generation Operation capability. Adding another initiating or
controlling surface requires an explicit change to the closed role-by-kind
policy rather than inheriting access from Project visibility.

Workbench learns about committed generation results through ordinary Project
changes and generated-asset metadata, not through generation Operation
snapshots. Product Quit terminates active generation directly without exposing
generic Operation control through Control or Workbench. This was chosen to preserve the current product surface, where
only the `debrute` CLI submits model requests, and to avoid turning the Runtime
refactor into a new Workbench generation feature. `CLI` names the authorized
product surface, not whether its caller is a human, Agent, or script.
