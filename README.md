# BatVu

BatVu is an experimental acoustic spatial intelligence module for RuView. It turns an iPhone into a short range active echolocation sensor by emitting near inaudible chirps, capturing echoes, registering them against device motion, and accumulating a confidence weighted acoustic map.

## Goal

BatVu does not claim camera or LiDAR class reconstruction from a single phone. Its initial target is practical acoustic spatial structure:

1. detect strong reflectors and range peaks
2. identify moving acoustic targets
3. estimate coarse surface geometry while the phone moves
4. accumulate echoes using IMU assisted synthetic aperture motion
5. export observations for RuView sensor fusion

## Architecture

```text
iPhone speaker
    |
    v
coded chirp / FMCW probe
    |
    v
room impulse response
    |
    v
iPhone microphones + AVAudioEngine
    |
    v
matched filter -> direct path cancellation -> CFAR -> peak split
    |
    v
range observations + confidence
    |
    +---- CoreMotion pose / orientation
    |
    v
acoustic mapper / synthetic aperture accumulator
    |
    v
BatVu acoustic point cloud
    |
    +---- RuVector temporal memory
    +---- RuView multimodal fusion
    +---- Horizon flywheel receipts / checkpoints
```

## Repository layout

* `ios/` native iPhone capture and motion registration reference implementation
* `packages/dsp/` deterministic TypeScript reference DSP used for tests and browser experiments
* `packages/protocol/` observation and benchmark contracts
* `docs/adr/` architecture decisions
* `tests/` deterministic synthetic room tests
* `vendor/ultrasonic/` git submodule for ultrasonic transport and waveform infrastructure
* `vendor/metaharness/` git submodule for Horizon and flywheel control primitives

## Initial signal design

The default experiment uses a configurable 17.5 kHz to 20 kHz linear chirp when hardware supports the requested bandwidth. The runtime records the actual audio sample rate and rejects configurations that violate Nyquist or calibrated transducer response constraints.

For a monostatic echo, range is estimated as:

```text
range_m = delay_samples / sample_rate * speed_of_sound_m_s / 2
```

Speed of sound is temperature compensated when ambient temperature is available. Every returned point includes confidence and provenance so RuView can down weight weak acoustic evidence.

## Development

```bash
git clone --recurse-submodules https://github.com/ruvnet/batvu.git
cd batvu
npm install
npm test
npm run bench
```

## Safety and privacy

BatVu processes raw acoustic frames locally by default. Raw microphone buffers are transient unless diagnostic recording is explicitly enabled. The system must not advertise ultrasound as universally inaudible because hearing range, device nonlinearities, and intermodulation vary by person and hardware.

## Status

Research prototype. The acceptance target for v0 is repeatable ranging and reflector mapping on real iPhone hardware with measured errors and false positive rates, followed by multimodal fusion in RuView.
