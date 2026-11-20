---
title: Judge the larger model by its transcribing time, not its loading
capabilities:
  - transcription/speech-models
review: unreviewed
---
# Judge the larger model by its transcribing time, not its loading

## Why

On the owner's PC (RTX 5090) choosing Large in Settings had no effect: `cue setup` reported
`largeSlow: true, largeInUse: false`, so every take went to the small models, although the owner
found Large much better on a 2.5-hour German review. After its download the app timed Large once on
the card against small on the processor, comparing whole `whisper-cli` runs of the 22 s sample, and
Large lost by 10 ms (2098 against 2088 ms). Most of a Large run is loading the 1.6 GB model: on the
same PC one run logs `load time = 1125 ms` and `total time = 1506 ms`, so it transcribes in about
0.4 s, against about 2.0 s for small on the processor. On real work the gap is wide: the 9047 s
microphone track took 113 s with Large on the card and 994 s with small on the processor.

## What changes

- After its download, the larger model's runs on the card count only the time spent transcribing,
  whisper's own `total time` less its `load time`, and are compared with the same for small on the
  processor; Large is used when it is no slower: "Loading the larger model does not count against
  it".
- A run whose log lacks whisper's timings counts its whole run: "A run without whisper's times
  counts whole".
- A saved measurement without the processor's transcribing time is made again in the background at
  the next start, and the larger model timed again, so a computer that judged Large slow on whole
  runs judges it again without the person asking: "A measurement without transcribing times is
  made again".

## Settled questions

- **Q1 What the larger model's check compares**: the time each run spends transcribing, from
  whisper's own log (`total time` less `load time`), Large on the card against small on the
  processor. Measured on the owner's PC: 0.38 s against 2.04 s. Rejected: a longer sample (loading
  still costs 1.1 s of each Large run, every processor run takes about three times longer, and the
  processor's noise stays); a margin on whole runs (a number picked by hand, rejected when the sample
  became 22 s); dropping the timed check and trusting the offer rule.
- **Q2 Scope**: only the larger model's check. Choosing the card over the processor and offering
  Large before its download stay on whole runs, because they choose right on this PC (small takes
  1.08 s on the card against 2.43 s on the processor) and each live stretch is its own run that pays
  the load. Rejected: every comparison on transcribing time, which can change the device other
  computers choose and would need the two-thirds offer rule worked out again.
- **Q3 Live stretches**: no extra check on whole runs. A card is offered Large only when it ran
  small, loading included, in two thirds of the processor's time, Large's runs must still succeed
  two at once, and even a few seconds per 20 s stretch keeps up with the recording; on the owner's
  PC a 22 s stretch takes 1.8 s with Large on the card against 2.4 s with small on the processor.
  Rejected: requiring Large's whole run to finish within the sample's length.
- **Q4 Summary**: confirmed as written here.

## Calls for the owner

- A run whose log has no `load time` or `total time` line (a runtime other than the bundled
  whisper.cpp build) counts its whole run, as before. The alternative, refusing Large without the
  lines, would hide it on such a runtime for good.
- The processor's transcribing time is saved beside its whole-run time
  (`processorTranscribingMs`), and a saved measurement without it is made again: the devices are
  timed again in the background (about 20 s on the owner's PC, then the four runs of Large), once.
  The alternative, waiting for the next app version or "Test the graphics card again", would leave
  a build from source at the same version on the small models.

## Out of scope

- Silent stretches that Large fills with invented text: a change of its own.
- The choice between the processor and a card, and the two-thirds rule that offers Large before its
  download: unchanged (Q2).
