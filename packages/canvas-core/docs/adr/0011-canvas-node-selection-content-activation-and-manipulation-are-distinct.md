---
status: accepted
---

# Canvas node selection, content activation, and manipulation are distinct

ADR 0015 supersedes only this ADR's text-presentation rule that Content
Activation is required to hand a preview to the live editor, including the
claim that an activation click has no selected-only presentation. Selection,
Content Activation, manipulation, and the video and audio decisions here remain
accepted.

Canvas Node Selection identifies the nodes targeted by Canvas commands and may
contain zero, one, or many nodes. Canvas Content Activation separately
identifies at most one text, video, or audio node whose Content Region accepts direct
content-specific interaction. Selection alone never activates content, while
Content Activation requires its node to be the sole selected node. Pointer
routing updates both according to the region that was used.

Only text, video, and audio nodes have a Content Region and Content Activation.
Text activation hands the preview to the live editor; video activation hands
the preview to the player and its keyboard routing; and audio activation gives
its project-styled Media Chrome player direct interaction ownership. Video and
audio playback do not depend on Canvas Node Selection or Content Activation.
Generic and image nodes have no Content Region.

Clicking either a Content Region or another region of a node selects that node.
Clicking a Content Region activates its text, video, or audio content. Clicking outside
the active Content Region ends Content Activation, including the same node's
title bar, its actions or resize handles, another node, or blank Canvas.

Text, video, and audio Content Regions never initiate Canvas Node movement.
Their title bar background is the Node Manipulation Region and is their only
move handle.
Title-bar actions select the node, end Content Activation, and perform their
action without moving it. Resize handles select the node, end Content
Activation, and resize without moving it. The visual node frame is paint, not a
pointer target for movement.

Ordinary click behavior commits only when the complete click succeeds. A click
on an inactive Content Region atomically selects its node and activates that
content, without an intermediate selected-only presentation. A click outside
the active Content Region atomically applies its selection result and ends
Content Activation; a press that moves away or is cancelled does neither.

Pointer-down in a Node Manipulation Region records a pending gesture without
changing selection or activation. Releasing below the movement threshold
commits its ordinary click. Crossing the threshold commits node selection,
ends Content Activation, and begins movement. Resize is already an explicit
direct-manipulation gesture, so starting resize selects the node and ends
Content Activation immediately.

Every selection transaction enforces the one-way activation invariant. If its
result is empty, contains multiple nodes, or selects another node, Content
Activation ends. Returning to a sole text, video, or audio selection does not restore
activation. Projection removal continues to prune both states.

A Content Activation Click preserves the current one-click handoff. The one
successful unmodified click atomically sole-selects and activates the node,
then applies its content action exactly once after the content target is ready.
Text carries the original client coordinates into the mounted editor, focuses
it, and places the caret at the corresponding valid document position. Video
turns the same activation request into one playback toggle. The request is
scoped to its node and consumed once; Canvas does not dispatch a synthetic
second DOM click, and a cancelled gesture applies neither effect.

The handoff guarantees one unmodified primary click, not a synthetic
multi-click sequence across the inactive-to-active DOM transition. If the user
starts a double-click while content is inactive, the first click performs the
activation handoff and its one content action. A later physical click is
handled normally if the active Content Region is ready, but Canvas does not
replay the pair as text word selection, video fullscreen, or any other
`dblclick` action. Each delivered physical click is applied at most once.

The inactive text preview also does not forward a press-drag sequence into the
newly mounted CodeMirror editor. Movement beyond the ordinary click threshold
cancels the activation candidate without selecting text, moving the node, or
panning Canvas. After the editor is active, text selection drags belong
entirely to CodeMirror. This deliberately avoids a second pointer-capture and
selection-handoff protocol solely for a gesture that starts before the editor
exists.

Wheel routing follows the control that can actually consume local scrolling,
not Content Activation alone. An active Text Content Region consumes an
ordinary wheel only while focus is inside its CodeMirror editor; inactive text,
active text whose editor is not focused, and audio or video content route the
ordinary wheel to Canvas. Text scrolling is contained at its boundaries and
does not chain into Canvas movement. Command/Control-wheel and trackpad pinch
remain Canvas zoom gestures even while CodeMirror is focused. Audio and video
progress and volume controls use their own pointer and keyboard interactions,
not wheel bindings.

Audio keeps one stable Media Chrome control composition mounted in both states,
with a native audio element as its playback engine and no native browser
controls. Clicking an inactive button atomically sole-selects and activates the
audio node while that same trusted click applies the targeted control action
exactly once. Clicking empty player background activates without toggling
playback. Beginning a time-range or volume-range drag is explicit direct
manipulation: pointer-down atomically sole-selects and activates the audio node,
then the same range gesture continues without Canvas capture. No synthetic
second event is dispatched.

A live video player that remains mounted while content-inactive uses the same
control handoff. An inactive video button click activates and applies that
button action once, and an inactive video time- or volume-range press activates
on pointer-down and continues the same range gesture. Clicking the video media
surface or its non-control background activates and toggles playback once. A
paused inactive preview represents that same media-surface action. Audio differs
only in that its empty player background activates without toggling playback.

An activation or content error is presented only inside the affected Content
Region. The Node Manipulation Region and title bar do not acquire an error
badge, status, or retry affordance. The error copy says that the Content Region
may be clicked to retry, and the complete Content Region is that retry target;
there is no separate retry button. A retry is a new Content Activation Click,
not an automatic replay of the consumed request. Canvas adds no bespoke
keyboard-only retry protocol or acceptance case. An implementation may use a
native interactive element for the complete error surface and inherit its free
keyboard behavior, but no parallel focus or key state machine is introduced.

If the editor or player fails before it takes ownership of the Content Region,
the node remains selected but Content Activation ends. The error presentation
is therefore an activatable, content-inactive retry surface. Clicking it starts
a new Content Activation Click;
after a successful handoff, text places the caret from that new click and video
applies exactly one playback toggle. The failed request is invalidated, as is
any pending request whose node loses Activation, Selection, or Canvas
membership, so delayed readiness cannot steal focus or toggle playback later.

Terminal media load, decode, or playback failures after handoff converge on the
same Content Region error model. Buffering and temporary stalls do not. A
terminal failure preserves Node Selection, ends Content Activation, marks the
medium as not playing, and replaces the Content Region with the click-to-retry
surface while discarding the failed media element. Retry constructs a fresh
player. A successful video retry applies the retry click's one playback toggle;
a successful audio retry restores and activates its controls without autoplay.
The Node Manipulation Region and title bar remain free of media error state.

An unmodified primary click on an inactive Content Region performs its atomic
selection and activation. An additive-modifier click on an inactive Content
Region belongs to Canvas multi-selection instead, does not activate that
content, and ends any current Content Activation. Once a Content Region is
active, its editor or player owns modifier keys such as Shift, Command, and
Control; Canvas keeps its node selected without interpreting those modifiers as
node-selection commands. Modifier clicks in a Node Manipulation Region retain
the ordinary Canvas additive-selection contract.

Video playback remains distinct from Content Activation. Losing activation,
changing Selection, or pressing Escape does not implicitly pause or seek. A
playing video may retain its live player while content-inactive, without Canvas
video hotkeys. Pausing, seeking, or ending while the player remains
content-active does not by itself persist a Playback Position or produce a
preview; player and Feedback actions continue to own those live playback
changes, while unloading owns Playback Position capture. Audio playback
likewise does not follow Selection or Activation. Its player remains mounted
when Activation ends, preserving the browser playback, current-time, and
buffered state without adding an unload and restore lifecycle.

Content Activation remains singular while video playback is zero-to-many. A
video player is eligible to hand off to its derived preview and unload only when
the video is both content-inactive and not playing; neither condition alone is
sufficient. Every playing video remains mounted, including while another video
owns Content Activation or while the playing node is outside the viewport, so
starting a second video does not pause or unload the first.

The editor-to-preview and paused-video-to-preview handoffs keep the existing
editor or player mounted until the preview has actually committed. If the node
is reactivated first, reactivation only invalidates that pending unload and
reuses the still-mounted instance; no duplicate instance, synthetic event
replay, or second restoration path is introduced. A preview result that
finishes later may remain cached, but its stale unload callback cannot
replace reactivated content. If preview ownership and unload already committed,
the next activation follows the normal fresh-mount path.

Viewport culling is not a media lifecycle boundary: a playing audio or video
node that merely moves offscreen remains a Canvas member and keeps playing.
Projection membership is the hard boundary. Collapsing an ancestor directory,
removing the file, changing projects, or closing Canvas stops playback and
unmounts the media when the node leaves the projection. The Workbench does not
create a player registry independent of projected nodes. Re-entry creates a new
instance; video may use its already persisted Playback Position, while no live
audio or video element is restored.

Click-away applies across the complete Workbench, not only CanvasSurface. A
successful primary click outside the active Content Region ends Content
Activation, including clicks on blank Canvas, another node, Canvas overlays,
floating panels, or Workbench chrome. An editor- or player-owned popup or portal
may declare a Content Interaction Island and is treated as an extension of its
Content Region. Window blur, pointer-down alone, a cancelled click, and opening
a context menu do not themselves end Content Activation.

Context-menu invocation is not a Click-away transition, but it retains the
existing Canvas context-selection rules. Invoking the menu on the active node
preserves its sole Selection and Activation, including from its title bar;
invoking it on another unselected node selects that node and therefore ends the
old Activation through the selection invariant; invoking it on blank Canvas
clears Selection and therefore Activation. A Workbench context menu invocation
that does not change Canvas Selection preserves both states. A later primary
click on a menu command is an ordinary completed Workbench click.

Ending Content Activation outside Canvas does not itself clear Canvas Node
Selection. Feedback Bars, floating panels, and Workbench chrome preserve the
current Selection while ending Activation, so they may continue to operate on
the selected node. Canvas targets still apply their existing selection result:
another node selects that node, while blank Canvas clears Selection when its
ordinary completed-click rule does so.

Escape unwinds interaction layers. A content-owned popup, editor, or player
first consumes Escape when it has a local dismissal. Otherwise Escape ends
Content Activation while preserving Canvas Node Selection; a following Escape
uses the existing Canvas command to clear Selection. An active move, resize, or
Selection Marquee is cancelled before either state changes, and higher-level
modal UI retains its own Escape priority.

Canvas Content Activation does not mirror browser focus. Tab navigation,
programmatic focus changes, element blur, and window blur do not change
Selection or Activation, so the Workbench adds no focus-driven activation
listener. More generally, Canvas does not add keyboard-specific equivalents for
pointer-only edge cases: CodeMirror, Media Chrome, and native controls retain
their built-in keyboard behavior, while the existing Canvas Escape command and
navigation commands remain. Text receives keys through its focused editor. Video shortcuts are
handled together with audio shortcuts by Media Chrome's local keyboard
handling, enabled only on the active node's `MediaController`; Canvas does not
interpret individual media keys. The actual focused element must remain inside
that active Content Region for its key event to reach the local controller,
while controls and ranges retain their own key ownership. Focus elsewhere
therefore suppresses shortcuts without mutating Activation.

Audio and video disable Media Chrome hotkeys while content-inactive and enable
them while content-active. Audio excludes unsupported captions, fullscreen,
and picture-in-picture commands, while video retains its applicable media
capabilities. Both omit the library's keyboard-shortcut dialog inside Canvas.
The previous window-level Canvas video hotkey controller, target registry,
focus-exclusion list, and delayed mount request are removed rather than run in
parallel. A key pressed during the brief video preview-to-player handoff is
ignored and is never replayed after mount.

Canvas removes the node-wide Feedback Frame and its special suppression of node
outlines. Feedback Bars, saved Capsules, marks, and spatial annotations retain
their existing ownership; a future replacement for feedback-presence display
must not overload Selection or Content Activation visuals.

Presentation keeps interaction responsibilities distinct without adding a
persistent border for Content Activation. Hover uses a weak neutral node
outline; Selection uses a persistent stronger orange outer outline; and an
inactive activatable Content Region uses a weak teal inner hover affordance.
Content Activation itself adds no border or ring. A Node Manipulation Region
uses a highlighted title bar with `grab`, changing to `grabbing` only during
movement, while resize retains its directional handles and cursors. A selected,
content-active node therefore retains only its orange Selection outline; its
active editor or player owns the content-specific interaction. Exact token
values may be tuned without changing these visual responsibilities.

Audio keeps its Media Chrome controls clear and readable while
content-inactive; it does not reduce the complete player opacity or otherwise
look disabled. Content hover supplies the weak teal affordance and Selection
the orange outer outline, while Activation adds no border or ring. Playing
audio continues to publish its live play state and progress while
content-inactive. Its rectangular control region uses
Debrute surfaces, dividers, control hover, and focus tokens and removes the
native browser control pill and semicircular ends.

Nodes without a Content Region retain direct manipulation. The complete
non-action surface of root, directory, generic, unknown, and image nodes may
select and move the node; directory click still toggles disclosure only when
the gesture remains below the move threshold. Feedback geometry owns its
pointer gesture while an image feedback tool is active. Text, video, and audio
movement remains title-bar-only. Action, resize, and feedback targets always
override a parent manipulation target.

DOM hit testing publishes stable semantic regions: `content`, `manipulation`,
`action`, `resize`, and `feedback`, plus `content-island` for a content-owned
popup or portal. A region never changes identity because its content becomes
active. The central pointer router combines that stable region with current
Runtime state, modifiers, and the completed gesture to derive all state
transitions. The migration removes dynamic `activate` versus `passive` zones,
native browser audio controls, and component-local state-dependent routing
exceptions.

A Content Interaction Island rendered outside CanvasSurface carries both
`data-canvas-node-zone="content-island"` and its owner's
`data-canvas-node-path`. The Workbench completed-click boundary preserves
Activation only when that path equals the active Content Region. An unowned or
stale island is ordinary Workbench click-away.

The decision boundary covers the complete Workbench only for Canvas Node
Selection and Canvas Content Activation. Canvas targets additionally contribute
their semantic region and resolved gesture; non-Canvas Workbench targets usually
contribute only whether Activation is retained or ended. The decision boundary
does not absorb editor selection, player controls, panel commands, navigation,
or other component-local behavior.

This separation makes selection feedback, editor or player activation, and
layout manipulation independently visible and testable. It requires one
central pointer-routing decision rather than component-local activation and
move exceptions.

## Interaction acceptance baseline

The implementation and its tests share the following behavioral baseline:

| Completed interaction | Selection result | Content Activation result | Local result |
| --- | --- | --- | --- |
| Click inactive text content | Text is the sole selection | Activate text | Place the caret from that click |
| Click inactive video content | Video is the sole selection | Activate video | Toggle playback exactly once |
| Click an inactive video control button | Video is the sole selection | Activate video | Apply that button action exactly once |
| Begin an inactive video time or volume drag | Video is the sole selection | Activate video immediately | Continue the same range gesture |
| Click an inactive audio button | Audio is the sole selection | Activate audio | Apply that button action exactly once |
| Begin an inactive audio time or volume drag | Audio is the sole selection | Activate audio immediately | Continue the same range gesture |
| Click inactive audio player background | Audio is the sole selection | Activate audio | Do not toggle playback |
| Click active content | Preserve its sole selection | Preserve Activation | Editor or player handles the click |
| Click another text, video, or audio content region | New node is the sole selection | Activate the new node | Apply its one content click |
| Click a Node Manipulation Region | Select that node | End Activation | Do not move; directory disclosure may toggle |
| Drag a Node Manipulation Region past threshold | Select that node | End Activation | Move the node |
| Click a title-bar action | Select that node | End Activation | Run the action once without movement |
| Start resize | Select that node | End Activation | Resize immediately |
| Additive-modifier click inactive content | Apply Canvas multi-selection | Do not activate and end prior Activation | Do not place a caret or toggle playback |
| Click a Workbench panel or chrome | Preserve Canvas Selection | End Activation | Let the Workbench target act |
| Click blank Canvas | Apply the existing blank-click selection rule | End Activation | Let blank Canvas act |
| Click the active content's Content Interaction Island | Preserve Selection | Preserve Activation | Let the island act |
| Right-click without a selection change, window blur, or cancelled gesture | Preserve Selection | Preserve Activation | Do not replay a delayed content action |
| Right-click another node or blank Canvas | Apply existing context-selection rule | Enforce the selection invariant | Open the context menu without a separate Click-away transition |
| Activation handoff fails | Preserve target Selection | End Activation | Show the click-to-retry content error |
| Click the retry surface and handoff succeeds | Preserve sole Selection | Activate content | Use the new click for the one content action |
| Start a double-click on inactive content | Apply the first click normally | Activate on the first successful handoff | Do not synthesize or replay a cross-handoff `dblclick`; handle any later delivered click normally |
| Drag beyond the click threshold in inactive text content | Preserve Selection | Preserve Activation | Cancel the activation candidate; do not select text, move the node, or pan Canvas |
| Ordinary wheel over focused active text | Preserve Selection | Preserve Activation | Scroll CodeMirror without chaining to Canvas |
| Ordinary wheel elsewhere on Canvas | Preserve Selection | Preserve Activation | Pan Canvas, including over inactive content and media content |
| Command/Control-wheel or pinch over Canvas | Preserve Selection | Preserve Activation | Zoom Canvas, including while CodeMirror is focused |

A table-driven pure decision suite owns completed primary-click and gesture
threshold state-transition combinations. Runtime tests own restoration from a
recorded pre-gesture snapshot, while context-menu and Escape tests own their
separate, explicitly non-click transitions.
Targeted DOM tests verify stable region publication and exactly-once handoff,
while the existing real-browser verification covers browser-owned focus, caret,
media, hit-testing, and gesture behavior. Tests at those outer layers do not
repeat the pure table's complete combinatorial matrix.

## Implementation ownership

The migration retains the existing Canvas Runtime and does not introduce a
Workbench-wide state machine or a tldraw Store dependency. A pure Canvas
interaction policy is the single decision authority for completed primary
clicks and move, resize, or marquee threshold transitions in the acceptance
table. Cancellation restores the Runtime's recorded pre-gesture transaction;
context menu and Escape retain their existing semantic routes.
The DOM adapter only resolves stable regions; CanvasSurface tracks and resolves
browser gestures and performs the one-time content handoff; and node components
only publish regions and execute editor, player, native-control, or action-local
behavior. A thin Workbench boundary forwards successful non-Canvas clicks to
the same policy without absorbing the clicked component's own behavior.

CanvasEditorRuntime applies policy results through one private atomic state
commit that updates Selection and Content Activation together and enforces the
activation invariant before publishing one coherent snapshot. Existing public
Selection commands required by Explorer, rename, delete, focus, and select-all
continue through that atomic path. The unconstrained public
`setContentInteraction(path)` write path is removed in favor of semantic
activate and end-activation commands.

Beginning a Node Manipulation gesture records only pending pointer state.
Selection and Activation remain unchanged until a completed click or the first
movement beyond the drag threshold; that transition atomically selects, ends
Activation, and starts movement. Resize retains its immediate transaction.
Legacy `activate`, `passive`, `move`, and `interaction-island` zones,
state-dependent region attributes, native audio controls, and component-local
transition exceptions are deleted rather than retained as compatibility paths.

Media Chrome remains the shared audio and video control vocabulary. Canvas
Content Activation only gates each controller's local hotkeys; Media Chrome
owns the key-to-media-command mapping. This avoids both a global Workbench
keyboard listener and a second Canvas-owned media shortcut implementation.
