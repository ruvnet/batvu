# ADR 0001: iPhone acoustic spatial intelligence architecture

## Status

Accepted for prototype validation.

## Decision

BatVu will treat the iPhone as a short range active acoustic sensor and will not represent acoustic output as LiDAR equivalent geometry. The system emits coded near inaudible chirps, records echoes, estimates reflector ranges, registers observations with device motion, and publishes confidence weighted spatial evidence for RuView fusion.

## Components

1. Waveform layer. Reuse useful signal and transport infrastructure from `ruvnet/ultrasonic`, but add dedicated ranging waveforms and calibration. Communications FSK is not itself a ranging waveform.
2. DSP layer. Matched filtering, direct path cancellation, adaptive thresholding, multipath aware peak selection, Doppler features, and environmental sound speed compensation.
3. Motion layer. CoreMotion orientation and inertial state register sequential scans. Future experiments may incorporate ARKit pose solely as a reference or optional fusion input, not as ground truth for acoustic claims.
4. Mapping layer. Accumulate probabilistic reflector observations into a local acoustic occupancy or point representation.
5. RuView integration. Export timestamped observations with position, bearing or uncertainty cone, range, confidence, waveform id, calibration id, and device provenance.
6. Flywheel layer. Use MetaHarness Horizon checkpoints and evidence receipts to evaluate candidate waveform and detector configurations against frozen datasets and physical device benchmarks.

## Why this is viable

Commodity smartphones can emit near inaudible chirps, capture echoes, and combine acoustic observations with inertial sensing. Published smartphone echoic SLAM work has demonstrated sub meter trajectory localization in multiple indoor settings. This establishes feasibility for location fingerprints and useful spatial constraints, but not dense camera quality room reconstruction.

## Physical limits

At 48 kHz sampling, one sample of monostatic time of flight corresponds to about 3.6 mm of path range, but practical spatial accuracy is much worse because the dominant errors are transducer bandwidth, speaker to microphone coupling, multipath, clock and buffering uncertainty, room impulse overlap, direct path cancellation, device orientation, and target reflectivity.

A 2.5 kHz chirp bandwidth has a theoretical range resolution on the order of `c/(2B)`, about 6.9 cm before implementation losses. Wider effective bandwidth improves range resolution but becomes harder to keep near inaudible and within phone speaker and microphone response.

## Calibration

Every device profile must measure:

* actual active sample rate
* speaker to microphone direct path impulse response
* usable ultrasonic frequency response
* per route latency and buffer behavior
* microphone data source and polar pattern
* thermal estimate for sound speed when available

Profiles are versioned and included in every observation receipt.

## Privacy and safety

Raw microphone frames remain local and transient by default. Diagnostic audio requires explicit opt in. The UI must describe signals as near inaudible rather than inaudible. Output amplitude is conservative and configurable because children, animals, and device nonlinearities may make nominal ultrasonic probes audible or objectionable.

## Flywheel promotion gate

A candidate configuration may replace the current parent only when all required datasets show no regression and physical device benchmarks meet the release threshold. The simulator cannot be the sole promotion authority.

Required metrics include range MAE, 95th percentile range error, reflector precision and recall, false positive rate per scan, mapping drift, processing latency, thermal load, and battery cost.

## Prototype acceptance criteria

1. Static planar reflector range MAE at 0.5 to 4 m is below 0.15 m across at least three representative rooms.
2. 95th percentile error is below 0.35 m.
3. False positives are below 0.2 per scan after direct path suppression.
4. Processing remains below 20 ms per scan on the target iPhone for a 20 Hz mapping mode.
5. A walking room scan produces a stable coarse acoustic map that aligns with independently measured wall geometry within 0.30 m median error.
6. RuView can ingest observations without raw audio and preserve confidence plus provenance.
