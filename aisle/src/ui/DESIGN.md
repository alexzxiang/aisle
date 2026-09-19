# Aisle — UI design plan (Agent A)

Read at two metres by a sighted teammate, operated one-handed by a blind user through
VoiceOver and the app's own speech. Ten rules; everything in `src/ui/` is built to them.

1. **One screen, one instruction.** The current instruction is the hero: `44 pt / weight 800 /
   letterSpacing −0.8 / left-aligned / ≤ 12 words`, inside a full-bleed state band. Nothing
   competes with it. No cards, no gradients, no icons, no all-caps, no middle-dot metadata.
2. **The band is the memorable element and the only colour in the app.** Its colour encodes
   mode: `#1A1F2A` idle/practice, deep night-blue `#0E2450` outdoor walking, amber `#6B3D00`
   at the curb, deep teal `#08403B` in the store, `#18323F` done. While crossing it shows
   the signal in OKO's convention — green `#0B4A26` walk, red `#7C1220` hand, orange
   `#7A3A00` countdown, dark grey `#262B33` unknown.
3. **Never colour alone.** The band always carries the mode word (`16 pt / 600`, e.g. "At the
   curb") above the hero, and at the curb or crossing the signal word is stated in the
   perception strip as a sentence ("Signal: walk, seen 1 s ago").
4. **Palette.** Background `#0A0C10`, text `#F2F4F7`, meta `#A8B0BD`, hairline `#1E232C`.
   Text on every band colour is `#F2F4F7` and measures ≥ 7:1 (lowest: countdown 7.83:1);
   meta grey is never used on a band. Tokens live in `theme.ts`; `theme.test.ts` recomputes
   every ratio, so a colour edit that breaks contrast fails the suite.
5. **Three sizes, one family.** hero 44, body 20, meta 16 — the iOS system font, nothing
   else. Distances and clock values use `fontVariant: ['tabular-nums']`.
   `allowFontScaling` stays on everywhere; the hero caps at 1.6× so it cannot push the
   talk button off-screen.
6. **Layout (portrait), top to bottom = VoiceOver order.** state band (mode word + hero) /
   perception strip / push-to-talk / two secondary targets. The strip has three fixed slots
   — Signal, Vehicles, Aisle — each a plain sentence row that keeps its place when empty
   ("Signal: not seen"), so position alone identifies it.
7. **Targets.** Push-to-talk is full-width and 96 pt ("Hold to talk", "Listening" while
   held). With a screen reader on it is a **toggle** ("Tap to talk" / "Listening. Tap to
   stop", `accessibilityState.busy` while listening): a VoiceOver double-tap delivers
   press-in and press-out milliseconds apart, so hold-to-talk would open and close the mic
   at once. `TalkButton` reads `AccessibilityInfo.isScreenReaderEnabled` and follows
   `screenReaderChanged`. The two secondary targets are 64 pt, side by side: "Repeat" and
   "Stop guidance" (tap once to arm, tap again or hold two seconds to stop — never a single
   stray tap). Nothing is smaller than 44 pt. Spacing scale: 4 / 8 / 12 / 16 / 24 / 32.

   **"Stop guidance" under a screen reader.** The hold is gone for the same reason the talk
   button's is: VoiceOver's activate delivers press-in and press-out milliseconds apart, so
   `onLongPress` never arrives and advertising it in the hint is a lie. `NavScreen` reads
   `useScreenReader()` and, when one is running, drops `onLongPress`, swaps the hint for
   "Double-tap, then double-tap again to end guidance", widens the armed window from 5 s to
   12 s (VoiceOver navigation between the two taps costs swipes and a focus change), and
   announces "Tap again to stop" through `announceForAccessibility`, because a label that
   changes under a resting focus is not re-read. Both taps stay explicit either way.
8. **One deliberate motion.** The band colour cross-fades over 250 ms on mode or signal
   change; that is the only animation. Under reduce-motion it swaps instantly.
9. **Accessibility contract.** Every control has `accessibilityRole` + label (and a hint
   where the gesture is not obvious); the hero is the single `accessibilityLiveRegion`
   ("polite") / `aria-live` surface so a screen reader announces exactly one changing
   thing; the DebugPanel opens on a 1.5 s long-press of the mode word (never a three-finger
   tap or a shake, which belong to VoiceOver and Expo).

   **Decision — iOS has no live region, and that is mostly right.** React Native honours
   `accessibilityLiveRegion` on Android (TalkBack) only. On iOS, the demo platform, the
   app's own speech already carries every instruction, and reading each hero on top of it
   is the double-speaking 08 flags as R22. So VoiceOver relies on app speech, with one
   fallback: when a hero changes and app speech has not carried it (nothing is speaking and
   no utterance started within `HERO_ANNOUNCE_GRACE_MS` = 1.5 s — the speech policy dropped
   it, or there is no speech service), `StateBand` reads the new hero once through
   `AccessibilityInfo.announceForAccessibility`. A newer hero cancels a pending
   announcement; the mount never announces; without a screen reader nothing is announced.
   The Android live region stays as it is.
10. **Copy.** Sentence case, plain verbs, the same verb through a flow, numbers as words.
    Errors say what happened and what to do next (`derive.errorSentence`: route, voice,
    camera, network and location get a sentence; store/speech/ui errors stay in the
    DebugPanel). The words *safe, clear, go, go now, cross now, no cars, you can cross*
    never appear in any rendered string — `copy.ts` owns the list, the screen tests
    assert on rendered output, and `scripts/lint-phrases.ts` greps the source.

## Band rules in detail

- **One instruction, one mode.** Every hero instruction is tagged with the mode the app was
  in when it was issued (`derive.Instruction.mode`; the store applies the transition before
  the UI reduces the event because the bus runs typed listeners before `onAny`). A fresh
  instruction from another mode is stale and is never shown, so "Crossing ahead: Forbes"
  cannot survive a re-plan and "Entering the store" does not follow the user down the
  aisle. State that legitimately carries across a mode edge (the walk signal from the curb
  into the roadway) comes back through the mode's standing hero, not through the tag.
- **Transient hazards expire.** Vehicle and obstacle lines hold the band for four seconds,
  scan reports for ten, then the standing instruction returns. Leg, crossing, signal and
  aisle lines hold until replaced.
- **At the curb the band says what is known.** Unsignalized: "No signal here. Listen for
  traffic". Signalized, no reading yet: "Line up with the crossing". A reading of UNKNOWN:
  "Can't see the signal". A state: the OKO word ("Walk signal on", "Don't walk",
  "Countdown"), or "Walk already on. Wait for the next one" when `fresh` is false.
- **Home while planning.** After a request the band reads "Planning a route for eggs" until
  `ROUTE_READY` moves the app on, with a quiet Cancel beside the note; the keyboard path
  normalises "I need eggs, please" to `eggs` locally (`copy.normalizeTypedItem`), emits
  `ITEM_REQUESTED {source: 'keyboard'}` at once and speaks "Eggs. Planning the route." The
  planner is the voice path's job, never a dependency of the typed one.

## The camera, the scene line and the narration toggle

- **The camera yields.** Both screens cap the viewfinder at a share of the window (0.46 on
  the trip screen, 0.42 on Home), but a flat share is wrong on a short phone: 46 % of an
  iPhone SE's 667 pt leaves the transcript at its minimum and pushes the talk button off the
  bottom. `theme.cameraMaxHeight(windowHeight, share, reserve)` also subtracts the points the
  rest of the screen needs — band, transcript minimum, talk button, two targets — and floors
  the result at `sizes.cameraMinHeight`. The demo phone is unaffected; the SE gets a
  viewfinder that fits.
- **The scene line is not a status bar.** Home always shows it, because the camera is the page
  there and "Looking around…" is the honest answer before the first reading. The trip screen
  shows it only once the app believes something (`derive.showSceneLine`) — never
  "Looking around…" mid-walk — and never in `APPROACH_CROSSING`, `AT_CURB` or `CROSSING`,
  where rule 1 says nothing competes with the band and the user is listening for traffic.
- **Quiet is not mute.** The pill beside "Describe surroundings" toggles the standing
  narration (`describeSurroundings`, the same preference as Settings) and nothing else:
  guidance, crossing facts, hazard warnings and every CRITICAL line keep speaking. Each
  label names the action rather than the state — "Quiet" when narration is on, "Narrate"
  when it is off — so a screen reader announces what a tap will do, with
  `accessibilityState.selected` carrying the state.

## Seams the integrator wires (`Root` props; helpers in `adapters.ts`)

`voice={voicePortFrom(voiceInput)}` (press-in → `begin`, press-out → `end`, failures
cancelled so the mic never stays open); `audio={audioPortsFrom(channels)}` (beacon and
ticker for the onboarding demonstrations and the DebugPanel mutes); `metrics` (tier
latencies, battery); `mockControls` (D's jump-to-mode, manual signal, `forceEnter`,
fixture picks — rendered at the bottom of the DebugPanel); `betaNotice` (B's Google
walking-routes sentence). Every prop is optional and every screen renders without it.
