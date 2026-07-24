# Issue tracker: Local Markdown

Issues and specs for this repo live as Markdown files in `.scratch/`.

These files are local workflow state, not durable domain documentation. Before
removing completed work, promote lasting terminology and decisions into the
relevant `CONTEXT.md` or ADR.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at
  `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`
- Triage state is recorded as a `Status:` line near the top of each issue
- Comments and conversation history are appended under `## Comments`

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/`, creating the directory if
needed.

## When a skill says "fetch the relevant ticket"

Read the referenced file. The user will normally provide its path or issue
number.

## Wayfinding operations

- Map: `.scratch/<effort>/map.md`
- Child ticket: `.scratch/<effort>/issues/NN-<slug>.md`
- Type: `research`, `prototype`, `grilling`, or `task`
- Status: `claimed` or `resolved`
- Blocking: record dependencies as `Blocked by: NN, NN`
- Frontier: select the first open, unblocked, unclaimed ticket by number
- Claim: set `Status: claimed` before starting work
- Resolve: append the result under `## Answer`, set `Status: resolved`, and add
  a concise context pointer to the map
