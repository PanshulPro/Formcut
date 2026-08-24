/* ==========================================================================
   Hero elastic sheet
   ---------------------------------------------------------------------------
   Renders the hero frame sequence through ElasticMesh instead of a flat 2D
   canvas, so the photograph behaves like a piece of fabric under the pointer.

   Division of labour:
     js/script.js   owns scroll progress, frame decoding and letterbox-bar
                    detection. It emits `hero:frame` whenever the sequence
                    advances and skips its own 2D paint while we are live.
     this module    owns the WebGL sheet and just re-textures it per frame.

   Falls back silently to the existing 2D canvas when WebGL is unavailable or
   the visitor prefers reduced motion.
   ========================================================================== */

import { createElasticMesh } from "./elastic-mesh.js";

const host = document.getElementById("heroMesh");
const canvas2d = document.getElementById("heroCanvas");

if (host && canvas2d) {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const probe = document.createElement("canvas");
  const hasWebGL = !!(probe.getContext("webgl") || probe.getContext("experimental-webgl"));

  if (hasWebGL && !reduceMotion) {
    const mesh = createElasticMesh(host, {
      // full-bleed: no perspective tilt, no rounded corners, sheet pushed
      // edge to edge so it reads as the hero image, not a floating card
      fit: 1,
      tilt: 0,
      borderRadius: 0,
      showGrid: false,
      /* Tuned for physical realism rather than a visible "effect": strong
         enough shading that the deformation reads as light falling across a
         real surface, and a denser grid so the fold curves smoothly instead
         of faceting. Softer spring + heavier damping give it the weight of
         cloth rather than the snap of rubber. */
      shading: 0.72,
      stiffness: 0.036,
      damping: 0.135,
      grabRadius: 0.58,
      pull: 0.58,
      wobble: 4.2,
      resolution: 52,
      interaction: "hover",
      highlight: "#f7f7f6",
    });

    document.documentElement.dataset.heroMesh = "on";
    host.classList.add("is-live");
    canvas2d.hidden = true;

    document.addEventListener("hero:frame", (e) => {
      const { img, bounds } = e.detail || {};
      mesh.setImage(img, bounds);
    });

    // ask script.js for the frame it has already painted
    document.dispatchEvent(new CustomEvent("hero:mesh-ready"));
  }
}
