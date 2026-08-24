/* ==========================================================================
   ElasticMesh - vanilla port of the React Bits component
   ---------------------------------------------------------------------------
   Source: reactbits.dev (ElasticMesh, JS + CSS variant, depends on `ogl`).

   Why a port rather than a drop-in: this project is vanilla HTML/CSS/JS with
   no bundler and no React. The original component is a thin React shell
   (useRef for the container, useEffect for setup/teardown, a propsRef so the
   render loop can read live prop values) wrapped around imperative WebGL.
   All of that maps cleanly onto a plain factory function:

     useRef(container)  -> the element passed in
     useEffect setup    -> body of createElasticMesh()
     useEffect cleanup  -> the returned destroy()
     propsRef.current   -> the mutable `opts` object

   The shaders, spring solver and normal recomputation are unchanged from the
   original. `ogl` is loaded from a CDN as an ES module so no install step is
   needed.
   ========================================================================== */

import { Renderer, Geometry, Program, Mesh, Texture } from "https://cdn.jsdelivr.net/npm/ogl@1.0.11/+esm";

const DIST = 4.6;
/* Default framing from the original component. `fit` is overridable so the
   sheet can be pushed edge-to-edge (fit: 1) for full-bleed use. */
const FIT = 0.82;

const VERT = `
precision highp float;
attribute vec2 aGrid;
attribute vec2 uv;
attribute vec3 aOffset;
attribute vec3 aNormal;

uniform float uAspect;
uniform float uTilt;
uniform float uDist;
uniform float uFit;

varying vec2 vUv;
varying vec3 vNormal;
varying float vDepth;

void main() {
  vUv = uv;

  vec2 base = vec2((aGrid.x * 2.0 - 1.0) * uAspect, 1.0 - aGrid.y * 2.0);
  vec3 p = vec3(base + aOffset.xy, aOffset.z);

  float ct = cos(uTilt);
  float st = sin(uTilt);
  float ry = p.y * ct - p.z * st;
  float rz = p.y * st + p.z * ct;
  p.y = ry;
  p.z = rz;

  float persp = uDist / (uDist - p.z);
  vec2 clip = vec2(p.x / uAspect, p.y) * persp * uFit;

  vNormal = aNormal;
  vDepth = aOffset.z;
  gl_Position = vec4(clip, 0.0, 1.0);
}
`;

const FRAG = `
precision highp float;

varying vec2 vUv;
varying vec3 vNormal;
varying float vDepth;

uniform sampler2D tMap;
uniform float uHasImage;
uniform vec2 uTexScale;
uniform vec2 uTexOffset;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform vec3 uHighlight;
uniform float uShading;
uniform vec2 uRes;
uniform float uRadius;
uniform float uGrid;
uniform float uGridDensity;
uniform float uGridOpacity;
uniform vec3 uGridColor;

void main() {
  vec3 base;
  if (uHasImage > 0.5) {
    // uTexScale/uTexOffset let the caller cover-fit an arbitrary source
    // rect of the texture (used to crop the clip's letterbox bars)
    base = texture2D(tMap, vUv * uTexScale + uTexOffset).rgb;
  } else {
    base = mix(uColor1, uColor2, clamp(vUv.y, 0.0, 1.0));
  }

  vec3 N = normalize(vNormal);
  vec3 L = normalize(vec3(-0.35, 0.55, 0.78));
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 H = normalize(L + V);

  float diff = clamp(dot(N, L), 0.0, 1.0);
  float specRaw = pow(clamp(dot(N, H), 0.0, 1.0), 26.0);
  float specFlat = pow(clamp(H.z, 0.0, 1.0), 26.0);
  float spec = clamp((specRaw - specFlat) / (1.0 - specFlat), 0.0, 1.0);
  float ao = clamp(1.0 + vDepth * 0.45, 0.65, 1.25);

  vec3 lit = base * (1.0 - uShading * 0.28);
  lit += base * diff * uShading * 0.55;
  lit *= ao;
  lit += uHighlight * spec * uShading * 0.25;

  if (uGrid > 0.5) {
    vec2 g = vUv * uGridDensity;
    vec2 w = uGridDensity / max(uRes, vec2(1.0));
    vec2 d = abs(fract(g - 0.5) - 0.5) / max(w * 1.5, vec2(1e-4));
    float line = 1.0 - clamp(min(d.x, d.y), 0.0, 1.0);
    lit = mix(lit, uGridColor, line * uGridOpacity * (0.45 + diff * 0.55));
  }

  vec2 p = (vUv - 0.5) * uRes;
  vec2 halfRes = uRes * 0.5;
  float r = min(uRadius, min(halfRes.x, halfRes.y));
  vec2 q = abs(p) - (halfRes - r);
  float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  float alpha = 1.0 - smoothstep(-1.25, 1.25, sd);
  if (alpha <= 0.002) discard;

  gl_FragColor = vec4(lit, alpha);
}
`;

function hexToRgb(hex) {
  let h = (hex || "").replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h || "000000", 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const DEFAULTS = {
  image: "",
  color1: "#5227FF",
  color2: "#B19EEF",
  highlight: "#ffffff",
  showGrid: true,
  gridDensity: 20,
  gridOpacity: 0.28,
  gridColor: "#ffffff",
  borderRadius: 25,
  stiffness: 0.05,
  damping: 0.2,
  grabRadius: 0.6,
  pull: 0.4,
  wobble: 5,
  tilt: 14,
  shading: 0.5,
  resolution: 25,
  interaction: "hover",
  enabled: true,
  fit: FIT,
};

/**
 * @param {HTMLElement} container
 * @param {Partial<typeof DEFAULTS>} options
 * @returns {{ update(patch: object): void, destroy(): void }}
 */
export function createElasticMesh(container, options = {}) {
  if (!container) throw new Error("createElasticMesh: container is required");

  // stands in for the React propsRef - the loop reads live values from here
  const opts = { ...DEFAULTS, ...options };

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const renderer = new Renderer({
    alpha: true,
    antialias: true,
    dpr: Math.min(window.devicePixelRatio || 1, 2),
  });
  const gl = renderer.gl;
  gl.clearColor(0, 0, 0, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const N = Math.max(6, Math.min(40, Math.round(opts.resolution)));
  const nodeCount = N * N;

  const aGrid = new Float32Array(nodeCount * 2);
  const uv = new Float32Array(nodeCount * 2);
  const aOffset = new Float32Array(nodeCount * 3);
  const aNormal = new Float32Array(nodeCount * 3);

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const idx = j * N + i;
      const u = i / (N - 1);
      const v = j / (N - 1);
      aGrid[idx * 2] = u;
      aGrid[idx * 2 + 1] = v;
      uv[idx * 2] = u;
      uv[idx * 2 + 1] = v;
      aNormal[idx * 3 + 2] = 1;
    }
  }

  const quads = (N - 1) * (N - 1);
  const index = new Uint16Array(quads * 6);
  let t = 0;
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const a = j * N + i;
      const b = a + 1;
      const c = a + N;
      const d = c + 1;
      index[t++] = a;
      index[t++] = c;
      index[t++] = b;
      index[t++] = b;
      index[t++] = c;
      index[t++] = d;
    }
  }

  const geometry = new Geometry(gl, {
    aGrid: { size: 2, data: aGrid },
    uv: { size: 2, data: uv },
    aOffset: { size: 3, data: aOffset },
    aNormal: { size: 3, data: aNormal },
    index: { data: index },
  });

  const texture = new Texture(gl, { generateMipmaps: false, flipY: false });
  if (opts.image) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = opts.image;
    img.onload = () => {
      texture.image = img;
      program.uniforms.uHasImage.value = 1;
    };
  }

  const program = new Program(gl, {
    vertex: VERT,
    fragment: FRAG,
    transparent: true,
    cullFace: null,
    uniforms: {
      tMap: { value: texture },
      uHasImage: { value: 0 },
      uTexScale: { value: [1, 1] },
      uTexOffset: { value: [0, 0] },
      uColor1: { value: hexToRgb(opts.color1) },
      uColor2: { value: hexToRgb(opts.color2) },
      uHighlight: { value: hexToRgb(opts.highlight) },
      uGrid: { value: opts.showGrid ? 1 : 0 },
      uGridDensity: { value: opts.gridDensity },
      uGridOpacity: { value: opts.gridOpacity },
      uGridColor: { value: hexToRgb(opts.gridColor) },
      uShading: { value: opts.shading },
      uRes: { value: [1, 1] },
      uRadius: { value: opts.borderRadius },
      uAspect: { value: 1 },
      uTilt: { value: (opts.tilt * Math.PI) / 180 },
      uDist: { value: DIST },
      uFit: { value: opts.fit },
    },
  });

  const mesh = new Mesh(gl, { geometry, program });

  const baseX = new Float32Array(nodeCount);
  const baseY = new Float32Array(nodeCount);
  const pos = new Float32Array(nodeCount * 3);
  const vel = new Float32Array(nodeCount * 3);
  const accel = new Float32Array(nodeCount * 3);

  let aspect = 1;
  function refreshBase() {
    for (let idx = 0; idx < nodeCount; idx++) {
      baseX[idx] = (aGrid[idx * 2] * 2 - 1) * aspect;
      baseY[idx] = 1 - aGrid[idx * 2 + 1] * 2;
    }
  }

  /* Current texture source rect, in normalised 0-1 image space. Kept so a
     resize can re-derive the cover fit without the caller re-supplying it. */
  let srcRect = null;

  function applyTexFit() {
    if (!srcRect) {
      program.uniforms.uTexScale.value = [1, 1];
      program.uniforms.uTexOffset.value = [0, 0];
      return;
    }
    const { nx, ny, nw, nh, srcAspect } = srcRect;
    let sx = nw;
    let sy = nh;
    let ox = nx;
    let oy = ny;
    if (srcAspect > aspect) {
      // source is wider than the sheet -> trim its sides
      const k = aspect / srcAspect;
      sx = nw * k;
      ox = nx + (nw - sx) / 2;
    } else {
      // source is taller -> trim top and bottom
      const k = srcAspect / aspect;
      sy = nh * k;
      oy = ny + (nh - sy) / 2;
    }
    program.uniforms.uTexScale.value = [sx, sy];
    program.uniforms.uTexOffset.value = [ox, oy];
  }

  function resize() {
    const w = container.offsetWidth || 1;
    const h = container.offsetHeight || 1;
    renderer.setSize(w, h);
    aspect = w / h;
    program.uniforms.uAspect.value = aspect;
    program.uniforms.uRes.value = [w, h];
    refreshBase();
    applyTexFit();
  }

  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  const pointer = { x: 0, y: 0, tx: 0, ty: 0, active: false, targetActive: false };

  function toPlane(clientX, clientY) {
    const rect = container.getBoundingClientRect();
    const mx = (clientX - rect.left) / rect.width;
    const my = (clientY - rect.top) / rect.height;
    const clipX = mx * 2 - 1;
    const clipY = 1 - my * 2;
    const tt = ((opts.tilt || 0) * Math.PI) / 180;
    const ct = Math.cos(tt);
    const st = Math.sin(tt);
    const fit = opts.fit || FIT;
    const a = clipY / (ct * fit * DIST);
    const py = (a * DIST) / (1 + a * st);
    const persp = DIST / (DIST - py * st);
    pointer.tx = (clipX * aspect) / (persp * fit);
    pointer.ty = py;
  }

  function onMove(e) {
    toPlane(e.clientX, e.clientY);
    if (opts.interaction === "hover") pointer.targetActive = true;
  }
  function onEnter() {
    if (opts.interaction === "hover") pointer.targetActive = true;
  }
  function onLeave() {
    pointer.targetActive = false;
  }
  function onDown(e) {
    if (opts.interaction === "drag") {
      toPlane(e.clientX, e.clientY);
      pointer.x = pointer.tx;
      pointer.y = pointer.ty;
      pointer.targetActive = true;
    }
  }
  function onUp() {
    if (opts.interaction === "drag") pointer.targetActive = false;
  }
  function onTouch(e) {
    if (e.touches.length) {
      toPlane(e.touches[0].clientX, e.touches[0].clientY);
      pointer.targetActive = true;
    }
  }

  container.addEventListener("mousemove", onMove);
  container.addEventListener("mouseenter", onEnter);
  container.addEventListener("mouseleave", onLeave);
  container.addEventListener("mousedown", onDown);
  window.addEventListener("mouseup", onUp);
  container.addEventListener("touchstart", onTouch, { passive: true });
  container.addEventListener("touchmove", onTouch, { passive: true });
  container.addEventListener("touchend", onLeave);

  const STEP = 1 / 120;
  const MAX_SUB = 5;
  let accTime = 0;
  let last = performance.now();

  function substep() {
    const s = opts.stiffness;
    const retain = 1 - opts.damping;
    const coupling = 0.06 + opts.wobble * 0.032;
    const active = pointer.active && opts.enabled && !reduceMotion;
    const r = Math.max(0.08, opts.grabRadius) * 1.4;
    const invR = 1 / r;
    const force = opts.pull * 0.009;

    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const idx = j * N + i;
        const o3 = idx * 3;
        const ox = pos[o3];
        const oy = pos[o3 + 1];
        const oz = pos[o3 + 2];

        let ax = -s * ox;
        let ay = -s * oy;
        let az = -s * oz;

        let sumx = 0;
        let sumy = 0;
        let sumz = 0;
        let cnt = 0;
        if (i > 0) {
          const n = (idx - 1) * 3;
          sumx += pos[n];
          sumy += pos[n + 1];
          sumz += pos[n + 2];
          cnt++;
        }
        if (i < N - 1) {
          const n = (idx + 1) * 3;
          sumx += pos[n];
          sumy += pos[n + 1];
          sumz += pos[n + 2];
          cnt++;
        }
        if (j > 0) {
          const n = (idx - N) * 3;
          sumx += pos[n];
          sumy += pos[n + 1];
          sumz += pos[n + 2];
          cnt++;
        }
        if (j < N - 1) {
          const n = (idx + N) * 3;
          sumx += pos[n];
          sumy += pos[n + 1];
          sumz += pos[n + 2];
          cnt++;
        }
        ax += coupling * (sumx - cnt * ox);
        ay += coupling * (sumy - cnt * oy);
        az += coupling * (sumz - cnt * oz);

        if (active) {
          const dx = pointer.x - (baseX[idx] + ox);
          const dy = pointer.y - (baseY[idx] + oy);
          const d = Math.sqrt(dx * dx + dy * dy);
          const tnorm = d * invR;
          if (tnorm < 1) {
            const zBump = 1 - tnorm * tnorm;
            az += force * zBump * zBump * 6.0;
            if (d > 1e-4) {
              const pinch = tnorm * (1 - tnorm) * (1 - tnorm) * 6.75;
              const dir = (force * pinch * 1.6) / d;
              ax += dx * dir;
              ay += dy * dir;
            }
          }
        }

        accel[o3] = ax;
        accel[o3 + 1] = ay;
        accel[o3 + 2] = az;
      }
    }

    for (let k = 0; k < nodeCount; k++) {
      const o3 = k * 3;
      const nvx = (vel[o3] + accel[o3]) * retain;
      const nvy = (vel[o3 + 1] + accel[o3 + 1]) * retain;
      const nvz = (vel[o3 + 2] + accel[o3 + 2]) * retain;
      vel[o3] = nvx;
      vel[o3 + 1] = nvy;
      vel[o3 + 2] = nvz;

      let px = pos[o3] + nvx;
      let py = pos[o3 + 1] + nvy;
      let pz = pos[o3 + 2] + nvz;
      if (px > 1.2) px = 1.2;
      else if (px < -1.2) px = -1.2;
      if (py > 1.2) py = 1.2;
      else if (py < -1.2) py = -1.2;
      if (pz > 1.2) pz = 1.2;
      else if (pz < -1.2) pz = -1.2;
      pos[o3] = px;
      pos[o3 + 1] = py;
      pos[o3 + 2] = pz;
    }
  }

  function commit() {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const idx = j * N + i;
        const o3 = idx * 3;
        const iL = i > 0 ? idx - 1 : idx;
        const iR = i < N - 1 ? idx + 1 : idx;
        const iD = j > 0 ? idx - N : idx;
        const iU = j < N - 1 ? idx + N : idx;

        const lx = baseX[iL] + pos[iL * 3];
        const ly = baseY[iL] + pos[iL * 3 + 1];
        const lz = pos[iL * 3 + 2];
        const rx = baseX[iR] + pos[iR * 3];
        const ry = baseY[iR] + pos[iR * 3 + 1];
        const rz = pos[iR * 3 + 2];
        const dx = baseX[iD] + pos[iD * 3];
        const dy = baseY[iD] + pos[iD * 3 + 1];
        const dz = pos[iD * 3 + 2];
        const ux = baseX[iU] + pos[iU * 3];
        const uy = baseY[iU] + pos[iU * 3 + 1];
        const uz = pos[iU * 3 + 2];

        const txx = rx - lx;
        const txy = ry - ly;
        const txz = rz - lz;
        const tyx = ux - dx;
        const tyy = uy - dy;
        const tyz = uz - dz;

        let nx = txy * tyz - txz * tyy;
        let ny = txz * tyx - txx * tyz;
        let nz = txx * tyy - txy * tyx;
        if (nz < 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        aNormal[o3] = nx / len;
        aNormal[o3 + 1] = ny / len;
        aNormal[o3 + 2] = nz / len;

        aOffset[o3] = pos[o3];
        aOffset[o3 + 1] = pos[o3 + 1];
        aOffset[o3 + 2] = pos[o3 + 2];
      }
    }
    geometry.attributes.aOffset.needsUpdate = true;
    geometry.attributes.aNormal.needsUpdate = true;
  }

  /* Only run the solver while the sheet is actually on screen. The original
     runs its rAF unconditionally; on a long scrolling page that burns frames
     for a canvas nobody can see. */
  let onScreen = true;
  const io = new IntersectionObserver(
    ([entry]) => {
      onScreen = entry.isIntersecting;
      if (onScreen) last = performance.now();
    },
    { rootMargin: "120px" }
  );
  io.observe(container);

  let raf = 0;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!onScreen) {
      last = now;
      return;
    }

    program.uniforms.uShading.value = opts.shading;
    program.uniforms.uRadius.value = opts.borderRadius;
    program.uniforms.uTilt.value = (opts.tilt * Math.PI) / 180;
    program.uniforms.uColor1.value = hexToRgb(opts.color1);
    program.uniforms.uColor2.value = hexToRgb(opts.color2);
    program.uniforms.uHighlight.value = hexToRgb(opts.highlight);
    program.uniforms.uGrid.value = opts.showGrid ? 1 : 0;
    program.uniforms.uGridDensity.value = opts.gridDensity;
    program.uniforms.uGridOpacity.value = opts.gridOpacity;
    program.uniforms.uGridColor.value = hexToRgb(opts.gridColor);

    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.25) dt = 0.25;

    const tau = 0.06;
    const kLerp = 1 - Math.exp(-Math.max(dt, 1e-4) / tau);
    pointer.x += (pointer.tx - pointer.x) * kLerp;
    pointer.y += (pointer.ty - pointer.y) * kLerp;
    pointer.active = pointer.targetActive;

    accTime += dt;
    let sub = 0;
    while (accTime >= STEP && sub < MAX_SUB) {
      substep();
      accTime -= STEP;
      sub++;
    }
    if (accTime > STEP) accTime = 0;

    commit();
    renderer.render({ scene: mesh });
  }
  raf = requestAnimationFrame(frame);

  container.appendChild(gl.canvas);

  return {
    update(patch = {}) {
      Object.assign(opts, patch);
      if ("fit" in patch) program.uniforms.uFit.value = opts.fit;
    },

    /**
     * Swap the warped texture at runtime. Used by the hero, which pushes a
     * new frame every time the scroll sequence advances.
     * @param {HTMLImageElement} img decoded image
     * @param {{sx:number,sy:number,sw:number,sh:number}} [rect] source crop
     *        in image pixels; defaults to the whole image
     */
    setImage(img, rect) {
      if (!img || !img.naturalWidth) return;
      texture.image = img;
      program.uniforms.uHasImage.value = 1;

      const iw = img.naturalWidth;
      const ih = img.naturalHeight;
      const sx = rect ? rect.sx : 0;
      const sy = rect ? rect.sy : 0;
      const sw = rect ? rect.sw : iw;
      const sh = rect ? rect.sh : ih;
      srcRect = {
        nx: sx / iw,
        ny: sy / ih,
        nw: sw / iw,
        nh: sh / ih,
        srcAspect: sw / sh,
      };
      applyTexFit();
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      container.removeEventListener("mousemove", onMove);
      container.removeEventListener("mouseenter", onEnter);
      container.removeEventListener("mouseleave", onLeave);
      container.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      container.removeEventListener("touchstart", onTouch);
      container.removeEventListener("touchmove", onTouch);
      container.removeEventListener("touchend", onLeave);
      if (gl.canvas.parentElement === container) container.removeChild(gl.canvas);
      const lose = gl.getExtension("WEBGL_lose_context");
      if (lose) lose.loseContext();
    },
  };
}

export default createElasticMesh;
