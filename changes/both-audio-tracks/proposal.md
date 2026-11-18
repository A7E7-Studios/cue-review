---
title: Transcribe the system audio beside the microphone
capabilities:
  - transcription/transcribed-tracks
review: unreviewed
---
# Transcribe the system audio beside the microphone

## Why

A take recorded with the microphone and the system audio is transcribed from the microphone alone.
In a review held over a call, everything the other people say reaches the transcript only as far
as the microphone heard it from the speakers, while the clean system track is never read. The
agent that works from the transcript gets the reviewer's own words well and everyone else's badly,
and cannot tell who said what.

- Measured on a 2 h 31 min review held over a call, loudspeakers on: system audio was active for
  79 % of the take. While it was, a median 57 % of the microphone's speech-band energy was that
  same audio, arriving 100 to 170 ms late, about 20 dB below the system track and only about 7 dB
  below the reviewer's own voice.
- On ten minutes of it, one model read the system track as coherent German in 18 s; the microphone
  track of the same minutes came out degraded, fell into a repetition loop and took 177 s.

## What changes

- A take with both tracks gets a transcript of both, in time order: "The reviewer and the call are
  both in the transcript", "A take with one track is transcribed as before".
- Both tracks are transcribed while recording: "Both tracks are ready seconds after Stop".
- Each row says where it was heard, in the app and for the agent: "Rows are marked as microphone
  or computer audio", "An agent reads each row's track".
- What the microphone heard from the speakers is left out: "A call played through speakers appears
  once", "The reviewer's own words are kept", "A reviewer on headphones loses nothing".
- Each track has its own language: "The reviewer and the call speak different languages".
- An earlier recording gains its second track when it is transcribed again: "An earlier recording
  gains the call on Retry".

## Settled questions

- **Q5 Tracks**: both tracks, each transcribed on its own, merged by time and labelled. Rejected:
  both tracks unlabelled; one pass over the mix (the reviewer's voice is about 13 dB below the call
  in it, and nothing says who spoke).
- **Q6 Echo**: microphone speech that matches the system track is left out. Rejected: echo
  cancellation on the microphone track (keeps talk-over, but a larger build with a new audio
  dependency); leaving the echo in, which doubles the call's words.
- **Q15 Live**: both tracks are transcribed while recording. Rejected: the system track after Stop,
  which brings back minutes of waiting on a long session.
- **Q19 Summary**: confirmed as written here.

## Calls for the owner

- Built after `auto-language`: "The reviewer and the call speak different languages" needs its
  per-take detection, applied per track. Without it this change would hold both tracks to one
  language.
- A take with one track shows no track marks; marks appear only where two tracks were transcribed.
  Marking every row everywhere would be uniform, and noise on the common single-track review.
- Leaving out matching microphone speech loses words the reviewer says at the very moment the call
  talks through the speakers. On headphones nothing matches, so nothing is lost. Echo cancellation
  would keep those words; it is the follow-up if the loss shows in reviews.
- "Ready seconds after Stop" keeps the 5 s that live transcription already promises on the
  reference PC. Two tracks double the live work; `design.md` measures whether the CPU-only
  reference holds it, and says so before the build if it does not.
- The stored transcript and `cue transcript` gain a track on each row (`microphone` or `system`).
  Rows of single-track takes and of transcripts made earlier carry none, so nothing an agent reads
  today changes shape.
- The audio in the video and the mix stays as it is: the call is still heard twice on playback when
  the speakers were on. Only the transcript changes.
- The app does not follow the mute of a call app such as Teams; its own mute is what silences the
  microphone track.
- How alike two stretches of audio must be to count as the speakers, and over what delay, is set in
  `design.md` from the measurement above.

## Out of scope

- Echo cancellation, and cleaning the echo out of the played audio.
- Telling the people on a call apart from each other.
- Device audio of an Android or Quest recording, which stays as it is.
- A GPU speech runtime: `gpu-transcription`.
