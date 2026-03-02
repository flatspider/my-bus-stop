# Product Requirements Document: Rhythm Typing Game

**Working title:** Bus Watch
**Last Update:** 2026-03-02
**Authors:** Conor McManamon
**Status:** Living Document

---

## 1. Product Objective

Provide a quick and easy summary of the buses arriving at your bus stop.

## 2. Problem Statement

Transit apps (Apple Maps and Google Maps) provide inconsistent bus information that has caused me to miss the bus. The MTA website has better data, but is difficult to navigate and hard to read. I want a clean, dynamically rendered, one page app that shows when the next bus is coming to my local bus stop.

## 3. Scope

- A single user browser-based dashboard
- Clean visual design. Strong visual hierarchy directing user immediately to relevant bus
- Ability to enter bus stop code to customize bus stop
- Settings panel to tweak display per user

## 8. Target Audience & User Stories

**Primary audience:** Me. I open this app every day.

**Secondary audience:** Additional users who also want a clean interface.

### 8a. User Stories

- **As a user,** I want to see how long I have to get to the bus stop.
- **As a user,** I want to know if the bus after the initial one is close.
- **As a user,** I want to know how out of date the information on the page is.

### 8b. User Journey

1. Player lands on the page.
2. Glances at top card.
3. The user reads the distance of the bus in estimated minutes.
4. The user catches their bus.

## 10. Vision — Look and Feel

![alt text](image.png)

Jazz album covers, blues and blacks, lighting flickering.

- Notes glow and pulse on successful hits
- The background environment responds to play quality — lights brighten, crowd ambience swells, the scene comes alive when you're in a groove
- Misses don't punish harshly — a subtle flicker, not a jarring buzzer

## 11. Core Technical Challenges & Approaches

The central unsolved question: **How do you take an arbitrary audio file and turn it into a fun, playable note chart?**

### Approach A: Beat & Onset Detection (MVP Path)

Use **Essentia** (JS Library) to detect:

- Tempo (BPM) and beat positions
- Note onsets (moments where a new sound begins)
- Spectral features (brightness, energy) to inform difficulty mapping

And control playback use Tone.js for extreme control over note sounds.

Then algorithmically place keyboard notes at detected onset positions, using heuristics to choose which keys map to which events. This is fast, lightweight, and well-understood — but it doesn't capture _melody_, only rhythm.

**Best for:** Getting an MVP running quickly. Works great for percussion-heavy and rhythmically clear music. Less musical for complex harmonies.

### Approach B: ML-Powered Music Transcription

Use **Spotify's Basic Pitch** (open-source neural network) to transcribe audio into MIDI — extracting actual pitches, note durations, and polyphony. MIDI data maps directly to keyboard layout (pitch → key position). This gives melodically accurate charts that feel connected to what the player is hearing.

**Best for:** Making the typing feel like you're _playing the melody_. Requires a backend (the model is ~50MB and needs Python/PyTorch), adding 5–15 seconds of processing per song.

### Approach C: Source Separation + Layered Analysis (Target Architecture)

Use **Meta's Demucs** (or **HTDemucs**) to separate a song into stems — vocals, drums, bass, other instruments. Then apply different analysis to each stem:

- Drums → onset detection → rhythmic backbone of the chart
- Bass → pitch tracking → left-hand / lower-key patterns
- Melody/other → Basic Pitch transcription → right-hand / upper-key patterns
- Vocals → optionally display lyrics as typing targets during vocal sections

This produces the richest, most musical charts. Each difficulty tier can emphasize different stems (Chill = just drums, Groove = drums + bass, Virtuoso = full ensemble).

**Best for:** The full vision. Most compute-intensive. Demucs is heavy (~300MB model, benefits from GPU). Could run as a serverless GPU function (Replicate, Modal, or a lightweight FastAPI backend on a GPU instance).

## 12. Weird Ideas for Functionality

1. **Swing-aware scoring** (described in Section 6). Makes sloppy tapping more fun.

2. **Any-song playability.** Upload-and-play pipeline is a killer feature.

3. **Jazz club atmosphere as gameplay feedback.** Play well and the club comes alive: lights warm, crowd murmurs swell to cheers. Fall off the groove and the room gets quiet, the lights dim. Crowd Boos, cheers.

4. **Call and response mode** (described in Section 6). Adds a memory and listening dimension that pure reaction-time games lack. Directly references jazz tradition.

5. **Stem-aware difficulty.** Instead of just thinning out notes for easier difficulties, each tier plays a different _role in the band_. Easy mode plays the drums. Medium adds the bass line. Hard plays the full arrangement.

## 13. Success Metrics

1. Quick to start a song <10 secs after landing on page
2. Session length (how long does a user play)
3. Do users upload their own songs...?
4. Do they rate the auto-generated songs as fun?

## 14. Milestones

### Phase 1: Proof of Concept (Wednesday Morning)

- [ ] Establish interface types that each sub-process will need
- [ ] Static note stream falling on screen (PixiJS)
- [ ] Keyboard input detection with timing evaluation
- [ ] Hardcoded note chart for one 10 second clip — prove the core loop feels good
- [ ] Basic scoring (hit/miss/streak)
- [ ] Audio playback synced to note stream

**Exit criteria:** One song is playable end-to-end and it feels fun.

### Phase 2: Auto Generate Beat Map (Wednesday Evening)

- [ ] Load songs and generate (via essentia) beat maps for music library (NOT user uploaded)
- [ ] Difficulty tier generation (Chill / Groove from same analysis)
- [ ] Ensure audio playback synced to note stream in fun way
- [ ] Latency calibration tool

### Phase 3: Polish & Identity (Wednesday Evening)

- [ ] Jazz club visual design — background, lighting, note styling
- [ ] Audio design — ambient sounds, hit/miss feedback, transitions
- [ ] Curated song library (5–10 songs with tuned charts)
- [ ] Score summary screen
- [ ] Swing-aware scoring prototype

**Exit criteria:** The game looks and sounds like a finished product. Someone who didn't build it says "this is cool."

### Phase 4: Advanced Pipeline (Stretch)

- [ ] Source separation via Demucs
- [ ] Multiplayer songs simultaneously occuring
- [ ] Stem-aware difficulty (Virtuoso tier)
- [ ] Call and response mode
- [ ] Basic Pitch integration for melodic charts

**Exit criteria:** The chart quality on uploaded songs is noticeably more musical than Phase 2.

## 15. Tradeoffs & Open Questions

**Pre-built charts vs. auto-generation quality.** Auto-generated charts will never match hand-authored ones for quality. Mitigation: ship a curated library for first impressions, use auto-gen for user uploads where "good enough" is the bar.

**Server-side audio processing vs. client-side.** ML models (Basic Pitch, Demucs) need a backend. The fallback (essentia-style onset detection) can run server-side cheaply or potentially client-side via WASM. We should start with the simpler pipeline and upgrade.

**Typing as a mechanic — is it fun enough?** Typing might feel disconnected. The swing scoring and melodic key mapping are our answers to this, but it's an open design risk that needs playtesting early.

**Music licensing for curated library.** We need royalty-free or CC-licensed jazz recordings. Alternatively, we commission short original tracks. This has a cost. Open question: is there a corpus of high-quality Creative Commons jazz?

**Latency calibration UX.** Rhythm games live and die on sync. Most serious rhythm games (osu!, StepMania) require manual offset calibration. Can we make this invisible to casual players? Auto-detection via a "tap along to this beat" onboarding step is the leading idea.

## Technical Reference

See [Technical Notes: Note Rendering & Timing](technical-notes.md) for implementation details on how JSON note data becomes on-screen visuals, the scroll/spawn model, and audio-visual sync.

## Learning Lessons

- Generating a beatmap and PLAYING a beatmap are NOT the same. Make sure there are not too many notes to hit.
- How to pull down a remote branch: git fetch origin git switch branch-name

---

_This document is a living artifact. Update it as decisions are made and assumptions are tested._
