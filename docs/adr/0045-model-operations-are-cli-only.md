# Model Operations Are CLI Only

Only a client holding a live CLI Control-session credential may submit, list,
inspect, wait for, or cancel Model Operations. Any such CLI session may manage
every Model Operation in the current Runtime instance. Project reference is
result ownership and a list filter, not an Operation permission or
session-lifetime boundary. Runtime defines no role-by-kind matrix, per-Project
Operation ACL, or initiator ownership.

The five peer Model Kinds are image, video, text-to-speech, music, and sound
effect. `audio` is only a configuration and implementation grouping for the
latter three. Single and Batch are Execution Shapes rather than additional
Model Kinds. Browser, Desktop-host, native control, and Photoshop Bridge
sessions do not receive a CLI credential. Adding another initiating or
controlling surface requires an explicit product decision rather than
inheriting access from Project visibility.

Workbench learns about committed model results through ordinary Project changes
and Generated Asset metadata, not through Model Operation snapshots. Product
Quit terminates active Model Operations directly without exposing generic
Operation control through Control or Workbench. This was chosen to preserve the
current product surface, where only the `debrute` CLI submits Model Requests,
and to avoid turning the Runtime refactor into a new Workbench model-execution
feature. `CLI` names the authenticated product surface, not whether its caller
is a human, Agent, or script.
