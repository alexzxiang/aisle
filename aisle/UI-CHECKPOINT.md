# UI refresh checkpoint

Scope: improve the existing native interface, keeping navigation, perception,
voice gestures, stop confirmation, contrast, and reduced-motion behavior intact.

## Plan

- Put Home's voice and typed request ahead of the viewfinder.
- Give the primary voice control a distinct, compact horizontal treatment.
- Make guidance content scroll when space is constrained, retaining easy access
  to talk/repeat/stop on normal portrait screens.
- Refine headings, control spacing, and conversation grouping consistently.
- Run type checking, phrase lint, and existing UI/accessibility regression tests.

## Checkpoint: inspection complete

The current Home places a large camera before input. Guidance uses a fixed
vertical stack with a 200-point transcript minimum plus a tall microphone;
the combined minimum heights can exceed a small phone's viewport. Home's
conversation has no explicit height despite containing a flex-based scroller.
The exact Expo 57 reference required by AGENTS.md has been read.

Device visual verification remains required; no simulator is currently booted.

## Checkpoint: implementation and regression checks complete

- Home now presents voice and keyboard requests before the camera, labels the
  surroundings section, aligns panel gutters, and adjusts iOS keyboard insets.
- Talk is a dark full-width control with a compact disc and visible gesture cue.
- Guidance has scrollable content and a bottom control area; short viewports and
  large text put the controls inside the scroll surface instead.
- Buttons wrap/grow without two-line truncation. Conversations have a heading
  and a bounded scroll area. Mode labels use sentence case.
- No core navigation, perception, or voice-service changes; no new dependencies.
- Type checking, dependency lint, and phrase lint passed. All 218 existing UI
  tests passed. Four added regressions cover Home reading order and guidance
  at normal size, short height, and large text; the screen suite passes all 79.

Remaining manual review: launch on an iPhone, check the keyboard with a long
request, large Dynamic Type, VoiceOver talk/stop, and dragging the nested
conversation. Automated render tests do not verify native pixel layout.

Changes are local and uncommitted. Design decisions live at the top of
`src/ui/DESIGN.md`.
