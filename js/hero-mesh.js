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

/* Versioned import. /js/* is served `immutable` for a year, so a module
   fetched without a cache-busting query would never pick up a redeploy.
   Bump this alongside the ?v= on the <script> tag in the HTML. */
import { createElasticMesh } from "./elastic-mesh.js?v=6";

const host = document.getElementById("heroMesh");
const canvas2d = document.getElementById("heroCanvas");

if (host && canvas2d) {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const probe = document.createElement("canvas");
  const hasWebGL = !!(probe.getContext("webgl") || probe.getContext("experimental-webgl"));

  /* The sheet is driven by hover, which a touch device does not have, and the
     CSS makes it pointer-transparent there so it can never eat a scroll. That
     leaves it rendering a grid it will never deform - so on mobile it drops to
     a coarse, lightly shaded sheet that costs almost nothing on the GPU, and
     keeps the full physical treatment for desktop. */
  const COARSE = window.matchMedia("(pointer: coarse), (hover: none)").matches;

  const TUNING = COARSE
    ? {
        // barely there: a flat sheet with a hint of light across it
        shading: 0.18,
        resolution: 14,
        pull: 0.12,
        grabRadius: 0.3,
        wobble: 1.2,
      }
    : {
        /* Tuned for physical realism rather than a visible "effect": strong
           enough shading that the deformation reads as light falling across a
           real surface, and a denser grid so the fold curves smoothly instead
           of faceting. */
        shading: 0.72,
        resolution: 52,
        pull: 0.58,
        grabRadius: 0.58,
        wobble: 4.2,
      };

  if (hasWebGL && !reduceMotion) {
    const mesh = createElasticMesh(host, {
      // full-bleed: no perspective tilt, no rounded corners, sheet pushed
      // edge to edge so it reads as the hero image, not a floating card
      fit: 1,
      tilt: 0,
      borderRadius: 0,
      showGrid: false,
      // Softer spring + heavier damping give it the weight of cloth rather
      // than the snap of rubber. Shared by both tiers.
      stiffness: 0.036,
      damping: 0.135,
      interaction: "hover",
      highlight: "#f7f7f6",
      ...TUNING,
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
