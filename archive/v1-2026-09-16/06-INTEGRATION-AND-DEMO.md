# 06 — Integration, Timeline & Demo

## Dependency order

```
Hour 0-1   A: contracts.ts + stubs        ← everyone blocked until this lands
Hour 1-4   D: mocks + fixtures            ← B and C blocked on real testing until this lands
           A: haptics, speech, sensors
           C: vision proxy + prompt
           B: route fetch + parse
Hour 4-12  B: legs, turn haptics (mock)   C: capture loop, navigator (mock)
           D: transition detector          A: onboarding, DebugPanel
Hour 12-18 C: venue mapping walk (real store, real frames)
           D: fixtures from C's recording
Hour 18-24 Integration: real sensors on, mock off, one phone
Hour 24+   Rehearsals, backup build, pitch
```

Two hard serialization points: **A's contracts** and **D's mocks**. Everything
else genuinely parallelizes. If either slips, the whole schedule slips — protect
them.

---

## Integration rules

- Branch per agent: `agent-a-core`, `agent-b-outdoor`, etc. Merge to `main` only
  through the composition root (`App.tsx`), which **Agent A alone edits**.
- Nobody edits another agent's directory. A needed change to someone else's
  module is a message, not a commit.
- Contracts file changes require flagging to all four agents. A silent signature
  change is the single most likely cause of a lost hour.
- Integrate on **one designated phone**. Chasing device-specific haptic
  differences across four phones the night before is a trap.

---

## Demo run-of-show (target: 2.5 minutes)

| Time | Beat | Notes |
|---|---|---|
| 0:00 | Frame the problem in one sentence | "Finding eggs in an unfamiliar store is a genuinely hard, unsolved problem if you're blind." |
| 0:10 | Onboarding, 20 s excerpt | Let a judge feel two haptic patterns in their own hand. This is the moment the idea becomes tangible. |
| 0:30 | "I need eggs" → route starts | Keep outdoor short — it's the least novel leg |
| 0:50 | One turn with alignment haptics | Narrate: "notice it buzzes faster as he lands on the right heading" |
| 1:10 | **Transition fires** | *Slow down here.* This is the differentiator. Let the announcement land. |
| 1:25 | Indoor: aisle signs read aloud, alignment haptics | Show the DebugPanel vision output briefly — proves it's live, not scripted |
| 2:00 | "Dairy aisle. Eggs on your right." | The payoff |
| 2:10 | Checkout guidance → done | Completes the arc |
| 2:20 | Close on honest limitations | See below |

**Have a teammate ready on the manual override** throughout. If detection
misfires, they tap, nobody notices, the story continues.

---

## Pitch framing

Lead with the gap, not the tech:

> "There are good apps for walking to a store. There are none for what happens
> after you walk through the door. We built the handoff."

Do not lead with "we use AI to describe surroundings" — that's the crowded
framing, and judges who've seen prior work will pattern-match you to it
immediately.

---

## Anticipated judge questions

**"Hasn't this been done?"**
Yes, in pieces — Apple Vision Pro and LiDAR projects for obstacle awareness,
ShopTalk academically for grocery, Aira with human guides. None of them do the
outdoor-to-indoor handoff on hardware people already own, and none are
goal-directed to a specific item without a human in the loop. Name the prior art
yourself before they do; it reads as rigor rather than ignorance.

**"How do you localize indoors without LiDAR or GPS?"**
We don't localize absolutely. Stores are pre-mapped as an ordered aisle list;
the camera only answers "which sign am I looking at," and navigation is relative
order comparison. That's why it runs on any phone.

**"What about latency?"**
Safety-relevant feedback is haptic and fully on-device, under 100 ms. The vision
call runs every 2 seconds and only drives non-urgent guidance. Nothing the user
needs quickly waits on the network.

**"Is this safe?"**
It's a prototype and a supplement to a cane or guide dog, not a replacement. We
deliberately excluded street crossings and outdoor obstacle detection because
prototype-grade reliability isn't acceptable there. *Say this plainly — knowing
where your system shouldn't be trusted is a strength, and experienced judges
read it that way.*

**"How are you using Nemotron / ElevenLabs?"** (sponsor-category judges will ask)
Don't answer "we called their API." Answer with why the choice was load-bearing:
Nemotron Nano 2 VL leads OCRBench v2, and our entire indoor localization reduces
to reading aisle signs under motion — an OCR problem, on the model that's best at
it. For ElevenLabs, our phrase set is closed and terse by design, so we
pre-generate every fixed utterance with Flash v2.5 and ship it as bundled audio:
premium voice quality with zero runtime latency, working offline. That's an
architectural fit, not an integration checkbox, and it's the version of the
answer that wins a sponsor prize.

**"Have you tested with blind users?"**
Answer honestly. If you haven't, say so and name it as the first thing you'd do
next — with specifics ("we'd want to test whether the four-pattern vocabulary
survives a noisy store"). Claiming validation you don't have is far worse than
admitting the gap.

---

## Failure-mode checklist (run 30 minutes before demo)

- [ ] Backup fixture build loaded on a second phone, airplane mode tested
- [ ] Manual override button verified working
- [ ] NVIDIA NIM key valid, credits remaining, `/api/health` green
- [ ] ElevenLabs key valid, character quota remaining
- [ ] Cached audio bundled in the build (test by killing wifi and replaying)
- [ ] Phone volume up, screen-lock disabled, battery >60%
- [ ] Haptics tested on the *actual* demo phone
- [ ] Venue lighting checked if demoing live vision
- [ ] One person assigned to narrate, one to operate — never the same person

---

## If you finish early

In priority order:
1. Test with an actual blind or low-vision user, even for 15 minutes. It will
   change your demo and it's the single most credible thing you can say on stage.
2. Tighten utterance wording — cut every sentence to its shortest form.
3. Add a second mapped store to prove the store-map format generalizes.
4. Do **not** add features from the non-goals table. Depth in one venue beats
   breadth everywhere, and that's what separates a top-three project from a
   clever one.
