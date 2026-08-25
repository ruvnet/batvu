# ADR-017: Draw arcs, never points

**Status**: Accepted
**Date**: 2026-08-25
**Related**: ADR-001 (range-only), ADR-010 (inverse sensor model)

## Context

The renderer decides what users believe. Everything upstream can be scrupulous
about uncertainty and a display of crisp dots will still communicate a depth
camera.

The anisotropy is extreme. Range is measured to a few centimetres; bearing comes
entirely from where the phone was pointing through a cone tens of degrees wide,
which at 3 m is over a metre across. That is roughly **a hundred to one**. A dot
would be lying by that factor — and it would look better, sharper and more
impressive than the honest version, which is exactly why the rule needs to be
explicit rather than left to taste.

## Decision

**Never draw a point where the sensor measured an arc.**

Every echo is an arc whose angular extent is the beam width and whose radial
thickness is the range uncertainty. Drawn with **additive blending**, so
overlapping looks from different attitudes brighten where they agree — not a
stylistic choice, but a rendering of the actual mechanism by which the map forms
(ADR-010).

Three views, each answering a different question:

- **PPI** — "what is around me". The hero view, with labelled range rings and the
  blind zone drawn as a red disc rather than quietly omitted; an omitted blind
  zone reads as "nothing there".
- **A-scope** — "what did that last ping actually see". Raw envelope against
  range with detections marked. The honesty anchor: everything else presents
  conclusions, this shows the evidence, and when the map looks wrong this is the
  view that says why.
- **Coverage strip** — "where have I looked", with **both** coverage numbers
  reported, because turning on the spot sweeps 85% of bearings while touching 5%
  of the sphere.

Elevation foreshortens onto the plan view (`range · cos(elevation)`): drawing
slant range would push every ceiling return out into the walls.

Colour is an inferno ramp — perceptually monotone in lightness, so the signal is
carried by brightness and hue is decoration. A rainbow ramp puts false edges
wherever hue turns fastest and invents structure the sonar never measured.

Canvas 2-D rather than WebGL. The app draws a few thousand arcs, not a hundred
thousand points; WebGL would add a dependency and a class of failure (context
loss, driver quirks) for no measured gain.

## Consequences

- The display looks like a smear until the user sweeps, and then it sharpens.
  That is the correct impression and it is worth the first-impression cost.
- The renderer never reads the occupancy grid per frame — it draws from the
  detection list — so the map's representation (ADR-009) does not constrain the
  display, and a 1.7M-voxel scan does not cost a frame.
- The e2e test samples canvas pixels on all three views. A blank canvas is the
  classic silent failure: every number right, the state object perfect, and the
  user sees black.
- The persistence buffer is bounded at 4000 echoes. A long scan would otherwise
  accumulate every echo it ever saw until the frame time climbed and the app
  stalled.
