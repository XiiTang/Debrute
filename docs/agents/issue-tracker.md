# Issue tracker: Private synchronized Markdown

Issues and specs for this repo live as Markdown files in `.scratch/work/`.
The `.scratch` directory is a separate private Git repository so authorized
agents can synchronize workflow state across devices. The public Debrute
repository continues to ignore the entire directory.

These files are workflow state, not durable domain documentation. Before
removing completed work, promote lasting terminology and decisions into the
relevant `CONTEXT.md` or ADR.

## Conventions

- One feature per directory: `.scratch/work/<feature-slug>/`
- The spec is `.scratch/work/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at
  `.scratch/work/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`
- Triage state is recorded as a `Status:` line near the top of each issue
- Comments and conversation history are appended under `## Comments`

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/work/<feature-slug>/`, creating the directory
if needed.

## When a skill says "fetch the relevant ticket"

Run `git -C .scratch pull --ff-only`, then read the referenced file. The user
will normally provide its path or issue number.

## Wayfinding operations

- Map: `.scratch/work/<effort>/map.md`
- Child ticket: `.scratch/work/<effort>/issues/NN-<slug>.md`
- Type: `research`, `prototype`, `grilling`, or `task`
- Status: `claimed` or `resolved`
- Blocking: record dependencies as `Blocked by: NN, NN`
- Frontier: select the first open, unblocked, unclaimed ticket by number
- Claim: set `Status: claimed` before starting work
- Resolve: append the result under `## Answer`, set `Status: resolved`, and add
  a concise context pointer to the map

## Synchronization

- Clone `XiiTang/Debrute-workflow-private` at `.scratch` in a fresh checkout.
- Before work, pull with `git -C .scratch pull --ff-only`.
- Commit and push a ticket claim before changing Debrute source.
- On completion, record verification commands and the Debrute source commit SHA,
  resolve the ticket, then commit and push the workflow update.
- Track only reviewed workflow Markdown. Keep secrets, logs, locks, media,
  binaries, caches, downloads, toolchains, native-raster payloads, and Runtime
  output local and ignored.
- Never run parent-repository `git clean -ffdx` without explicitly excluding
  `.scratch/`.
