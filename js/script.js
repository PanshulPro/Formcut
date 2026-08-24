/* ==========================================================================
   FORMCUT - interaction layer
   ---------------------------------------------------------------------------
   Architecture:
     - ONE scroll engine. Every scroll-linked effect registers a callback;
       a single passive listener + rAF runs them all. No per-effect
       scroll listeners, no layout thrash from competing handlers.
     - Animation utilities are data-attribute driven so markup stays declarative:
         [data-reveal]        fade + rise on enter          (FadeIn / StaggerReveal)
         [data-split]         per-word mask wipe on enter   (TextReveal)
         [data-parallax]      sets --p (0-1) through viewport(Parallax)
         [data-count]         count-up on enter
         [data-magnetic]      pointer-follow on fine pointers
     - Everything above honours prefers-reduced-motion.
   ========================================================================== */

(() => {
  "use strict";

  /* The hero is a pinned scroll sequence, so a restored mid-pin scroll
     position drops the visitor into the middle of the animation with the
     headline already faded out. Always enter at the top. */
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";

  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const FINE_POINTER = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const clamp01 = (n) => Math.min(1, Math.max(0, n));

  /* ------------------------------------------------------------------------
     SCROLL ENGINE - single listener, single rAF, shared callback registry
     ------------------------------------------------------------------------ */
  const scrollJobs = [];
  let ticking = false;

  function onScrollFrame() {
    for (let i = 0; i < scrollJobs.length; i++) scrollJobs[i]();
    ticking = false;
  }

  function requestTick() {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(onScrollFrame);
    }
  }

  function registerScroll(job) {
    scrollJobs.push(job);
    job();
  }

  window.addEventListener("scroll", requestTick, { passive: true });
  window.addEventListener("resize", requestTick, { passive: true });

  /* Progress of an element through the viewport, 0 (entering) to 1 (leaving). */
  function viewportProgress(el) {
    const r = el.getBoundingClientRect();
    return clamp01((window.innerHeight - r.top) / (window.innerHeight + r.height));
  }

  /* Progress of a pinned section, 0 at pin start to 1 at pin end. */
  function pinProgress(el) {
    const r = el.getBoundingClientRect();
    const scrollable = r.height - window.innerHeight;
    return scrollable > 0 ? clamp01(-r.top / scrollable) : 0;
  }

  /* ------------------------------------------------------------------------
     REVEAL - one observer drives every [data-reveal] / [data-split] / counter
     ------------------------------------------------------------------------ */
  const revealTargets = document.querySelectorAll("[data-reveal], [data-split]");

  const revealObserver =
    "IntersectionObserver" in window
      ? new IntersectionObserver(
          (entries) => {
            entries.forEach((entry) => {
              if (!entry.isIntersecting) return;
              entry.target.classList.add("is-in");
              entry.target.querySelectorAll?.("[data-count]").forEach(runCounter);
              if (entry.target.matches("[data-count]")) runCounter(entry.target);
              revealObserver.unobserve(entry.target);
            });
          },
          { threshold: 0.15, rootMargin: "0px 0px -8% 0px" }
        )
      : null;

  /* TextReveal: wrap each word so it can wipe up behind its own mask.
     Walks text nodes only, so <br> and nested spans survive intact. */
  function splitWords(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue.trim()) textNodes.push(node);
    }

    let wordIndex = 0;
    textNodes.forEach((textNode) => {
      const frag = document.createDocumentFragment();
      textNode.nodeValue.split(/(\s+)/).forEach((chunk) => {
        if (!chunk.trim()) {
          frag.appendChild(document.createTextNode(chunk));
          return;
        }
        const outer = document.createElement("span");
        outer.className = "split-word";
        const inner = document.createElement("span");
        inner.textContent = chunk;
        inner.style.setProperty("--stagger", String(wordIndex++));
        outer.appendChild(inner);
        frag.appendChild(outer);
      });
      textNode.parentNode.replaceChild(frag, textNode);
    });
  }

  if (!REDUCED) {
    document.querySelectorAll("[data-split]").forEach(splitWords);
  }

  if (revealObserver) {
    revealTargets.forEach((el) => revealObserver.observe(el));
  } else {
    revealTargets.forEach((el) => el.classList.add("is-in"));
    document.querySelectorAll("[data-count]").forEach(runCounter);
  }

  /* Count-up */
  function runCounter(el) {
    if (el.dataset.counted) return;
    el.dataset.counted = "1";
    const target = parseFloat(el.dataset.count);
    if (Number.isNaN(target)) return;

    /* Group thousands: a capacity figure reads as "25,000", not "25000".
       data-count-plain opts out for values that are not quantities, such as
       a year, where a separator would be wrong. */
    const plain = el.hasAttribute("data-count-plain");
    const fmt = (n) => (plain ? String(n) : n.toLocaleString("en-IN"));

    if (REDUCED) {
      el.textContent = fmt(target);
      return;
    }
    const duration = 1400;
    const start = performance.now();
    const step = (now) => {
      const t = clamp01((now - start) / duration);
      // easeOutExpo
      const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      el.textContent = fmt(Math.round(target * eased));
      if (t < 1) requestAnimationFrame(step);
      else el.textContent = fmt(target);
    };
    requestAnimationFrame(step);
  }

  /* Parallax: publish --p on every registered element */
  const parallaxEls = document.querySelectorAll("[data-parallax], #cinematicMedia");
  if (parallaxEls.length && !REDUCED) {
    registerScroll(() => {
      parallaxEls.forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.bottom < -200 || r.top > window.innerHeight + 200) return;
        el.style.setProperty("--p", viewportProgress(el).toFixed(3));
      });
    });
  }

  /* ------------------------------------------------------------------------
     LOADER - tied to real frame decode, not a fake timer
     ------------------------------------------------------------------------ */
  const FRAME_COUNT = 16;
  const frames = [];
  /* This file is shared with quote.html, which has no hero. Only pull the
     ~536KB frame sequence down on pages that actually render it. */
  const HAS_HERO = !!document.getElementById("heroCanvas");

  /* WebP cuts the sequence from 811KB to 235KB. Probed rather than assumed:
     the JPEG copies stay in the repo because a browser that cannot decode the
     frames renders a blank hero, and that failure is silent. */
  const SUPPORTS_WEBP = (() => {
    try {
      return document.createElement("canvas")
        .toDataURL("image/webp")
        .startsWith("data:image/webp");
    } catch {
      return false;
    }
  })();
  const FRAME_EXT = SUPPORTS_WEBP ? "webp" : "jpg";

  if (HAS_HERO) {
    for (let i = 1; i <= FRAME_COUNT; i++) {
      const img = new Image();
      img.src = `assets/flowshirt/frame-${String(i).padStart(2, "0")}.${FRAME_EXT}`;
      frames.push(img);
    }
  }

  const loader = document.getElementById("loader");
  const loaderCount = document.getElementById("loaderCount");
  const loaderBar = document.getElementById("loaderBar");
  let loaded = 0;

  function bumpLoader() {
    loaded++;
    const pct = Math.round((loaded / FRAME_COUNT) * 100);
    if (loaderCount) loaderCount.textContent = String(pct);
    if (loaderBar) loaderBar.style.width = `${pct}%`;
    if (loaded >= FRAME_COUNT) finishLoading();
  }

  let loadingFinished = false;
  function finishLoading() {
    if (loadingFinished) return;
    loadingFinished = true;
    /* Guarded: on a page with no hero this runs before `ctx` is declared,
       and touching it in the temporal dead zone throws, which would abort
       the rest of this file (form validation, nav, theme, everything). */
    if (HAS_HERO) drawFrame(0);
    loader?.classList.add("is-done");
    document.documentElement.classList.remove("is-loading");
    document.documentElement.classList.add("hero-ready");
  }

  if (!HAS_HERO) {
    // no sequence to wait on - release the page immediately
    finishLoading();
  } else {
    frames.forEach((img) => {
      const settle = () => bumpLoader();
      if (img.complete && img.naturalWidth) {
        // decode() keeps the first paint of each frame off the main thread
        img.decode?.().then(settle).catch(settle) ?? settle();
      } else {
        img.addEventListener("load", settle, { once: true });
        img.addEventListener("error", settle, { once: true });
      }
    });

    // never trap the user behind a stalled asset
    setTimeout(finishLoading, 4000);
  }

  /* ------------------------------------------------------------------------
     HERO - scroll-scrubbed frame sequence on canvas
     ------------------------------------------------------------------------ */
  const heroEl = document.getElementById("top");
  const heroCanvas = document.getElementById("heroCanvas");
  const heroBar = document.getElementById("heroBar");
  const heroCopy = document.getElementById("heroCopy");
  const heroCaptions = Array.from(document.querySelectorAll("#heroCaptions .hero-caption"));
  let activeCaption = -1;
  const ctx = heroCanvas?.getContext("2d");
  let currentFrame = 0;

  function sizeCanvas() {
    if (!heroCanvas) return;
    const rect = heroCanvas.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (heroCanvas.width !== w || heroCanvas.height !== h) {
      heroCanvas.width = w;
      heroCanvas.height = h;
    }
  }

  /* The source clip has black letterbox bars baked in, and they ANIMATE:
     the early frames are a narrow slot that widens to full width by frame 8
     (a curtain reveal). A single fixed crop would either keep bars on the
     early frames or slice the labelled panels off the late ones, so each
     frame's real content box is measured once and cropped individually.
     Measured lazily on a tiny offscreen copy; falls back to the full frame
     if the canvas is tainted (opening the page over file://). */
  const boundsCache = new Map();

  function contentBounds(img, index) {
    if (boundsCache.has(index)) return boundsCache.get(index);

    const full = { sx: 0, sy: 0, sw: img.naturalWidth, sh: img.naturalHeight };
    let result = full;

    try {
      const SW = 120;
      const SH = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * SW));
      const off = document.createElement("canvas");
      off.width = SW;
      off.height = SH;
      const octx = off.getContext("2d", { willReadFrequently: true });
      octx.drawImage(img, 0, 0, SW, SH);
      const data = octx.getImageData(0, 0, SW, SH).data;

      const THRESHOLD = 28;
      let left = SW, right = -1, top = SH, bottom = -1;
      for (let y = 0; y < SH; y++) {
        for (let x = 0; x < SW; x++) {
          const i = (y * SW + x) * 4;
          const lum = Math.max(data[i], data[i + 1], data[i + 2]);
          if (lum > THRESHOLD) {
            if (x < left) left = x;
            if (x > right) right = x;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
          }
        }
      }

      if (right > left && bottom > top) {
        const kx = img.naturalWidth / SW;
        const ky = img.naturalHeight / SH;
        result = {
          sx: Math.max(0, Math.floor(left * kx)),
          sy: Math.max(0, Math.floor(top * ky)),
          sw: Math.min(img.naturalWidth, Math.ceil((right - left + 1) * kx)),
          sh: Math.min(img.naturalHeight, Math.ceil((bottom - top + 1) * ky)),
        };
      }
    } catch (err) {
      result = full; // tainted canvas (file://) - just use the whole frame
    }

    boundsCache.set(index, result);
    return result;
  }

  /* Returns true only when a frame was actually painted. The caller must not
     record the index as drawn otherwise: on a restored scroll position the
     target frame can still be decoding, and marking it drawn would leave the
     canvas blank until the index happened to change again. */
  function drawFrame(index) {
    if (!ctx) return false;
    const img = frames[index];
    if (!img) return false;
    if (!img.complete || !img.naturalWidth) {
      img.addEventListener("load", () => drawFrame(index), { once: true });
      return false;
    }

    /* When the WebGL sheet has taken over (js/hero-mesh.js) it renders the
       frame itself, so hand the frame across and skip the 2D paint. */
    if (document.documentElement.dataset.heroMesh === "on") {
      currentFrame = index;
      document.dispatchEvent(
        new CustomEvent("hero:frame", {
          detail: { img, index, bounds: contentBounds(img, index) },
        })
      );
      return true;
    }

    sizeCanvas();
    const cw = heroCanvas.width;
    const ch = heroCanvas.height;
    if (!cw || !ch) return false;

    /* object-fit: cover, done by hand over the frame's real content box.
       Scaling to the LARGER ratio fills the canvas and crops the overflow
       rather than stretching to the viewport aspect. Centred, so the
       garment stays in frame. */
    const { sx, sy, sw, sh } = contentBounds(img, index);
    const scale = Math.max(cw / sw, ch / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    const dx = (cw - dw) / 2;
    const dy = (ch - dh) / 2;

    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    currentFrame = index;
    return true;
  }

  if (heroEl && heroCanvas) {
    if (REDUCED) {
      const last = frames[FRAME_COUNT - 1];
      if (last.complete) drawFrame(FRAME_COUNT - 1);
      else last.addEventListener("load", () => drawFrame(FRAME_COUNT - 1), { once: true });
    } else {
      let lastDrawn = -1;
      registerScroll(() => {
        const r = heroEl.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) return;

        const progress = pinProgress(heroEl);
        const index = Math.min(FRAME_COUNT - 1, Math.round(progress * (FRAME_COUNT - 1)));
        if (index !== lastDrawn && drawFrame(index)) lastDrawn = index;
        if (heroBar) heroBar.style.width = `${progress * 100}%`;
        heroEl.style.setProperty("--hero-progress", progress.toFixed(3));
        // once faded, stop it swallowing clicks / cluttering the a11y tree
        heroCopy?.classList.toggle("is-hidden", progress > 0.3);

        // hand the slot over to the scroll captions
        let next = -1;
        for (let i = 0; i < heroCaptions.length; i++) {
          const el = heroCaptions[i];
          if (progress >= parseFloat(el.dataset.from) && progress < parseFloat(el.dataset.to)) {
            next = i;
            break;
          }
        }
        if (next !== activeCaption) {
          activeCaption = next;
          heroCaptions.forEach((el, i) => el.classList.toggle("is-current", i === next));
        }
      });
    }
    window.addEventListener("resize", () => drawFrame(currentFrame), { passive: true });

    /* hero-mesh.js is a deferred module, so it mounts after this script has
       already painted a frame. It fires this once it is live; re-emit the
       current frame so the sheet starts with the right texture instead of
       waiting for the next scroll tick. */
    document.addEventListener("hero:mesh-ready", () => {
      const img = frames[currentFrame];
      if (!img || !img.naturalWidth) return;
      document.dispatchEvent(
        new CustomEvent("hero:frame", {
          detail: { img, index: currentFrame, bounds: contentBounds(img, currentFrame) },
        })
      );
    });
  }

  /* ------------------------------------------------------------------------
     STACKED PANELS - each panel recedes as the next rides up over it.
     Publishes --panel-p (0 front, 1 fully covered) read by the CSS.
     ------------------------------------------------------------------------ */
  const panels = Array.from(document.querySelectorAll(".panel"));
  if (panels.length && !REDUCED) {
    /* Only pin panels that fit the viewport. A sticky element taller than
       the screen parks its top at 0 and everything below the fold becomes
       unreachable, which silently hid half the product grid. */
    let gradeQueued = false;

    function gradePanels() {
      gradeQueued = false;
      const vh = window.innerHeight;

      /* Read every height first, then write. Interleaving them would make
         each toggle invalidate layout for the next measurement. */
      const verdicts = panels.map((panel) => {
        /* offsetHeight, not scrollHeight: the cinematic panel holds an
           absolutely-positioned parallax layer inset by -12%, so its
           scrollHeight reports overflow it already clips. The laid-out
           box height is what decides whether pinning would hide content. */
        return panel.offsetHeight <= vh + 4;
      });

      panels.forEach((panel, i) => {
        const fits = verdicts[i];
        // only touch the DOM when the verdict actually changed, otherwise
        // every re-grade unpins and repins and the page visibly jumps
        if (panel.classList.contains("is-stacking") === fits) return;
        panel.classList.toggle("is-stacking", fits);
        if (!fits) panel.style.setProperty("--panel-p", "0");
      });
    }

    function queueGrade() {
      if (gradeQueued) return;
      gradeQueued = true;
      requestAnimationFrame(gradePanels);
    }

    gradePanels();

    /* Panels change height as images decode and webfonts swap in. Grading
       only on load meant a tall panel could sit wrongly pinned - and so
       visibly stuck - until everything finished downloading. Watching each
       panel means the verdict corrects the moment its height settles.
       Safe from feedback loops: toggling `position` does not alter
       offsetHeight, so a re-grade cannot resize what it just measured. */
    if ("ResizeObserver" in window) {
      const panelRO = new ResizeObserver(queueGrade);
      panels.forEach((p) => panelRO.observe(p));
    }

    window.addEventListener("resize", queueGrade, { passive: true });
    window.addEventListener("load", queueGrade);
    document.fonts?.ready.then(queueGrade);

    registerScroll(() => {
      const vh = window.innerHeight;
      for (let i = 0; i < panels.length; i++) {
        const panel = panels[i];
        if (!panel.classList.contains("is-stacking")) continue;

        const rect = panel.getBoundingClientRect();
        if (rect.bottom < -vh || rect.top > vh * 2) continue;

        // coverage comes from the NEXT panel climbing over this one
        const next = panels[i + 1];
        let p = 0;
        if (next) {
          const nTop = next.getBoundingClientRect().top;
          if (nTop < vh) p = clamp01((vh - nTop) / vh);
        }
        panel.style.setProperty("--panel-p", p.toFixed(3));
      }
    });
  }

  /* ------------------------------------------------------------------------
     HEADER - transparent over the dark hero, solid once past it
     ------------------------------------------------------------------------ */
  const header = document.getElementById("siteHeader");
  if (header && heroEl) {
    registerScroll(() => {
      const heroBottom = heroEl.getBoundingClientRect().bottom;
      const overHero = heroBottom > 84;
      header.classList.toggle("on-hero", overHero);
      header.classList.toggle("is-scrolled", !overHero);
    });
  }

  /* ------------------------------------------------------------------------
     HORIZONTAL SCROLL - vertical scroll drives horizontal travel
     ------------------------------------------------------------------------ */
  const hscroll = document.getElementById("capabilities");
  const hTrack = document.getElementById("hscrollTrack");
  const hBar = document.getElementById("hscrollBar");

  if (hscroll && hTrack) {
    /* The section's scroll runway must equal the horizontal distance the
       track needs to travel, or the pan finishes early / runs out of room. */
    function sizeHScroll() {
      const distance = Math.max(0, hTrack.scrollWidth - window.innerWidth + 40);
      hscroll.style.height = `${window.innerHeight + distance}px`;
      return distance;
    }

    let distance = sizeHScroll();
    window.addEventListener("resize", () => { distance = sizeHScroll(); requestTick(); }, { passive: true });

    if (REDUCED) {
      // no hijack: let it scroll horizontally by hand
      hTrack.style.overflowX = "auto";
      hscroll.style.height = "auto";
    } else {
      registerScroll(() => {
        const r = hscroll.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) return;
        const progress = pinProgress(hscroll);
        hTrack.style.transform = `translate3d(${-progress * distance}px, 0, 0)`;
        if (hBar) hBar.style.width = `${progress * 100}%`;
      });
    }
  }

  /* ------------------------------------------------------------------------
     PROCESS - step in view drives the sticky visual
     ------------------------------------------------------------------------ */
  const processSteps = document.querySelectorAll(".process-step");
  const processVisuals = document.querySelectorAll("#processVisual [data-step]");

  /* Deliberately NOT an IntersectionObserver. IO only reports threshold
     CROSSINGS, so a "last entry wins" active-step tracker goes stale the
     moment two steps change state in one frame - the highlight ends up one
     step ahead and the first step never activates at all. Picking the step
     nearest the viewport centre every frame is deterministic and cheap. */
  const processSection = document.getElementById("process");
  const processBar = document.getElementById("processBar");

  /* The section is pinned and has its own runway, so the active step comes
     straight from pin progress. Nothing inside scrolls on its own, which is
     what used to make the left-hand visual look stuck while the rest moved. */
  if (processSteps.length && processSection) {
    let activeStep = -1;

    registerScroll(() => {
      const r = processSection.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) return;

      const progress = pinProgress(processSection);
      if (processBar) processBar.style.width = `${progress * 100}%`;

      const count = processSteps.length;
      // slight inset so the first and last steps hold rather than flicker
      const eased = clamp01((progress - 0.04) / 0.9);
      const best = Math.min(count - 1, Math.floor(eased * count));

      if (best === activeStep) return;
      activeStep = best;

      const index = String(best);
      processSteps.forEach((s, i) => s.classList.toggle("is-current", i === best));
      processVisuals.forEach((v) => v.classList.toggle("is-current", v.dataset.step === index));
    });
  }

  /* ------------------------------------------------------------------------
     NAV - active link tracks the section in view
     ------------------------------------------------------------------------ */
  const navIds = ["capabilities", "products", "process", "about", "contact"];
  const navSections = navIds.map((id) => document.getElementById(id)).filter(Boolean);

  if (navSections.length && "IntersectionObserver" in window) {
    const navObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          document.querySelectorAll(".nav-links a.is-active").forEach((a) => a.classList.remove("is-active"));
          document.querySelector(`.nav-links a[href="#${entry.target.id}"]`)?.classList.add("is-active");
        });
      },
      { rootMargin: "-45% 0px -50% 0px", threshold: 0 }
    );
    navSections.forEach((s) => navObserver.observe(s));
  }

  /* ------------------------------------------------------------------------
     MOBILE NAV
     ------------------------------------------------------------------------ */
  const navToggle = document.getElementById("navToggle");
  const mobileNav = document.getElementById("mobileNav");
  const mobileNavClose = document.getElementById("mobileNavClose");

  function closeNav() {
    mobileNav?.classList.remove("is-open");
    navToggle?.setAttribute("aria-expanded", "false");
    document.body.style.overflow = "";
  }
  function openNav() {
    mobileNav?.classList.add("is-open");
    navToggle?.setAttribute("aria-expanded", "true");
    document.body.style.overflow = "hidden";
    mobileNavClose?.focus();
  }

  navToggle?.addEventListener("click", () =>
    mobileNav?.classList.contains("is-open") ? closeNav() : openNav()
  );
  mobileNavClose?.addEventListener("click", closeNav);
  mobileNav?.querySelectorAll("a").forEach((a) => a.addEventListener("click", closeNav));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && mobileNav?.classList.contains("is-open")) {
      closeNav();
      navToggle?.focus();
    }
  });

  /* ------------------------------------------------------------------------
     THEME
     ------------------------------------------------------------------------ */
  const root = document.documentElement;
  const themeToggle = document.getElementById("themeToggle");
  const sunIcon = themeToggle?.querySelector(".icon-sun");
  const moonIcon = themeToggle?.querySelector(".icon-moon");

  function paintThemeToggle() {
    const dark =
      root.getAttribute("data-theme") === "dark" ||
      (!root.hasAttribute("data-theme") && window.matchMedia("(prefers-color-scheme: dark)").matches);
    /* NOTE: `hidden` is an HTMLElement property. These are SVG elements, so
       `svg.hidden = true` would silently set a JS expando and never reflect
       to the attribute. Toggle the attribute explicitly instead. */
    const setHidden = (el, on) => {
      if (!el) return;
      if (on) el.setAttribute("hidden", "");
      else el.removeAttribute("hidden");
    };
    // show the icon for the mode the click will switch TO
    setHidden(sunIcon, !dark);
    setHidden(moonIcon, dark);
    themeToggle?.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
  }

  const savedTheme = localStorage.getItem("formcut-theme");
  if (savedTheme) root.setAttribute("data-theme", savedTheme);
  paintThemeToggle();

  themeToggle?.addEventListener("click", () => {
    const dark =
      root.getAttribute("data-theme") === "dark" ||
      (!root.hasAttribute("data-theme") && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const next = dark ? "light" : "dark";
    root.setAttribute("data-theme", next);
    localStorage.setItem("formcut-theme", next);
    paintThemeToggle();
  });

  /* ------------------------------------------------------------------------
     PRODUCT FILTER
     ------------------------------------------------------------------------ */
  const filterPills = document.querySelectorAll("[data-filter]");
  const productCards = document.querySelectorAll(".product-card");

  function applyFilter(category) {
    filterPills.forEach((p) => {
      const on = p.dataset.filter === category;
      p.classList.toggle("is-active", on);
      p.setAttribute("aria-pressed", String(on));
    });
    productCards.forEach((card) => {
      card.classList.toggle("is-hidden", category !== "all" && card.dataset.category !== category);
    });
  }

  filterPills.forEach((p) => p.addEventListener("click", () => applyFilter(p.dataset.filter)));
  document
    .querySelectorAll("[data-filter-link]")
    .forEach((l) => l.addEventListener("click", () => applyFilter(l.dataset.filterLink)));

  /* ------------------------------------------------------------------------
     QUOTE FORM - validation + mailto handoff
     ------------------------------------------------------------------------ */
  const productSelect = document.getElementById("fProduct");

  /* Product cards link to quote.html?product=... so the choice survives the
     page change. Preselect it if the option exists. */
  if (productSelect) {
    const wanted = new URLSearchParams(location.search).get("product");
    if (wanted) {
      const match = Array.from(productSelect.options).find((o) => o.value === wanted);
      if (match) productSelect.value = match.value;
    }
  }

  // same-page fallback for any enquiry link that is still an anchor
  document.querySelectorAll("[data-product]").forEach((link) =>
    link.addEventListener("click", () => {
      if (productSelect) productSelect.value = link.dataset.product;
    })
  );

  /* Used for the bot time-to-fill check. A form completed in under two
     seconds was not filled in by a person. */
  const formOpenedAt = Date.now();

  const form = document.getElementById("quoteForm");
  const formSuccess = document.getElementById("formSuccess");
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const PHONE_RE = /^[0-9\s-]{7,15}$/;

  const setError = (field, bad) => field.closest(".form-field")?.classList.toggle("has-error", bad);

  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    formSuccess?.classList.remove("is-visible");

    const name = document.getElementById("fName");
    const email = document.getElementById("fEmail");
    const phone = document.getElementById("fPhone");
    const code = document.getElementById("fPhoneCode");
    const message = document.getElementById("fMessage");
    const product = document.getElementById("fProduct");

    /* Wholesale only, so the company is required wherever the field exists.
       The short contact form on index.html has no company input - guard for it
       rather than assuming, or that page's form would never submit. */
    const company = document.getElementById("fCompany");

    const okName = name.value.trim().length > 1;
    const okEmail = EMAIL_RE.test(email.value.trim());
    const okPhone = PHONE_RE.test(phone.value.trim());
    const okCompany = !company || company.value.trim().length > 1;

    setError(name, !okName);
    setError(email, !okEmail);
    setError(phone, !okPhone);
    if (company) setError(company, !okCompany);

    if (!okName || !okEmail || !okPhone || !okCompany) {
      form.querySelector(".has-error input, .has-error select")?.focus();
      return;
    }

    // extra fields exist only on quote.html
    const qty = document.getElementById("fQty");
    const branding = document.getElementById("fBranding");
    const buyerType = document.getElementById("fBuyerType");
    const gstin = document.getElementById("fGstin");
    const val = (el) => (el && el.value.trim() ? el.value.trim() : null);

    const subject = `Wholesale enquiry${product.value ? ": " + product.value : ""}`;
    const body = [
      `Name: ${name.value.trim()}`,
      val(company) ? `Company: ${val(company)}` : null,
      val(buyerType) ? `Buyer type: ${val(buyerType)}` : null,
      val(gstin) ? `GSTIN: ${val(gstin)}` : null,
      `Email: ${email.value.trim()}`,
      `Phone: ${code.value} ${phone.value.trim()}`,
      product.value ? `Product: ${product.value}` : null,
      val(qty) ? `Quantity: ${val(qty)} pcs` : null,
      val(branding) ? `Branding: ${val(branding)}` : null,
      "",
      "Details:",
      message.value.trim() || "(no additional details provided)",
    ]
      .filter(Boolean)
      .join("\n");

    /* Post to the Worker. mailto is kept as the fallback path: if the API is
       unreachable, or the secrets are not set yet, the enquiry still reaches
       a human instead of silently evaporating. */
    const submitBtn = form.querySelector('[type="submit"]');
    const restore = submitBtn ? submitBtn.textContent : null;
    const mailtoFallback = () => {
      window.location.href = `mailto:hello@formcut.studio?subject=${encodeURIComponent(
        subject
      )}&body=${encodeURIComponent(body)}`;
      formSuccess?.classList.add("is-visible");
    };

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Sending...";
    }

    fetch("/api/enquiry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: name.value.trim(),
        company: val(company),
        buyerType: val(buyerType),
        gstin: val(gstin),
        email: email.value.trim(),
        phone: `${code.value} ${phone.value.trim()}`,
        product: product.value || null,
        quantity: val(qty),
        branding: val(branding),
        message: message.value.trim(),
        website: document.getElementById("fWebsite")?.value || "",
        elapsed: Date.now() - formOpenedAt,
      }),
    })
      .then(async (res) => {
        if (res.ok) {
          form.reset();
          formSuccess?.classList.add("is-visible");
          formSuccess?.scrollIntoView({ block: "center", behavior: REDUCED ? "auto" : "smooth" });
          return;
        }
        // 422 means the server rejected specific fields - surface them rather
        // than dumping the visitor into a mail client with bad data.
        if (res.status === 422) {
          const { errors: serverErrors = {} } = await res.json().catch(() => ({}));
          Object.keys(serverErrors).forEach((k) => {
            const el = document.getElementById("f" + k[0].toUpperCase() + k.slice(1));
            if (el) setError(el, true);
          });
          form.querySelector(".has-error input, .has-error select")?.focus();
          return;
        }
        mailtoFallback();
      })
      .catch(mailtoFallback)
      .finally(() => {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = restore;
        }
      });
  });

  ["fName", "fEmail", "fPhone", "fCompany"].forEach((id) => {
    const field = document.getElementById(id);
    field?.addEventListener("input", () => setError(field, false));
  });

  /* Newsletter - same mailto handoff, no backend to fake */
  const nlForm = document.getElementById("newsletterForm");
  const nlNote = document.getElementById("nlNote");
  nlForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("nlEmail");
    if (!EMAIL_RE.test(input.value.trim())) {
      if (nlNote) nlNote.textContent = "Enter a valid email address.";
      input.focus();
      return;
    }
    window.location.href = `mailto:hello@formcut.studio?subject=${encodeURIComponent(
      "Trade updates signup"
    )}&body=${encodeURIComponent(`Please add ${input.value.trim()} to trade updates.`)}`;
    if (nlNote) nlNote.textContent = "Thanks. Your email app will open to confirm.";
    input.value = "";
  });

  /* ------------------------------------------------------------------------
     CUSTOM CURSOR + MAGNETIC BUTTONS (fine pointer only)
     ------------------------------------------------------------------------ */
  if (FINE_POINTER && !REDUCED) {
    const cursor = document.getElementById("cursor");
    const cursorLabel = document.getElementById("cursorLabel");

    if (cursor) {
      let cx = window.innerWidth / 2;
      let cy = window.innerHeight / 2;
      let tx = cx;
      let ty = cy;

      window.addEventListener(
        "mousemove",
        (e) => {
          tx = e.clientX;
          ty = e.clientY;
          cursor.classList.add("is-active");
        },
        { passive: true }
      );
      document.addEventListener("mouseleave", () => cursor.classList.remove("is-active"));

      // own rAF: pointer easing must run every frame, not only on scroll
      (function follow() {
        cx += (tx - cx) * 0.18;
        cy += (ty - cy) * 0.18;
        cursor.style.transform = `translate3d(${cx}px, ${cy}px, 0)`;
        requestAnimationFrame(follow);
      })();

      const hoverables = document.querySelectorAll(
        "a, button, .product-card, .hcard, [data-cursor]"
      );
      hoverables.forEach((el) => {
        el.addEventListener("mouseenter", () => {
          cursor.classList.add("is-hover");
          const label = el.dataset.cursor || "";
          if (cursorLabel) cursorLabel.textContent = label;
        });
        el.addEventListener("mouseleave", () => {
          cursor.classList.remove("is-hover");
          if (cursorLabel) cursorLabel.textContent = "";
        });
      });

      // invert the ring over dark sections
      const darkZones = document.querySelectorAll(
        ".hero, .hscroll, .cinematic, .bigtype, .site-footer"
      );
      if (darkZones.length) {
        registerScroll(() => {
          let onDark = false;
          darkZones.forEach((z) => {
            const r = z.getBoundingClientRect();
            if (cy >= r.top && cy <= r.bottom) onDark = true;
          });
          cursor.classList.toggle("on-dark", onDark);
        });
      }
    }

    // Magnetic pull. Written straight to transform, never through state.
    document.querySelectorAll("[data-magnetic]").forEach((el) => {
      const strength = 0.28;
      el.addEventListener("mousemove", (e) => {
        const r = el.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height / 2);
        el.style.transform = `translate3d(${dx * strength}px, ${dy * strength}px, 0)`;
      });
      el.addEventListener("mouseleave", () => {
        el.style.transform = "";
      });
    });
  }

  /* ------------------------------------------------------------------------
     CONSTRUCTION DETAIL - one annotation at a time across the pinned runway
     ------------------------------------------------------------------------ */
  const detailSection = document.getElementById("detail");
  const detailItems = Array.from(document.querySelectorAll("#detailList .detail-item"));

  if (detailSection && detailItems.length && !REDUCED) {
    let activeDetail = -1;
    let unpinned = null; // null = undecided, so the first pass always applies

    registerScroll(() => {
      /* Below 900px the section is unpinned (see the media query), so there
         is no runway to read progress from and every item stays open. */
      const isUnpinned =
        getComputedStyle(detailSection.querySelector(".detail-sticky")).position !== "sticky";

      if (isUnpinned) {
        if (unpinned !== true) {
          unpinned = true;
          activeDetail = -1;
          detailItems.forEach((el) => el.classList.add("is-active"));
        }
        return;
      }
      if (unpinned !== false) {
        unpinned = false;
        activeDetail = -1; // force the next block to re-apply single-item mode
      }

      const p = pinProgress(detailSection);
      // hold the last item for the tail of the runway instead of running off
      // the end, so the section does not unpin on a blank state
      const next = Math.min(detailItems.length - 1, Math.floor(p * detailItems.length));
      if (next === activeDetail) return;
      activeDetail = next;
      detailItems.forEach((el, i) => el.classList.toggle("is-active", i === next));
    });
  }

  /* ------------------------------------------------------------------------
     RETURN TO POSITION
     Leaving index.html for the quote page remembers the reading position;
     "Back to site" hands it back. Needed because scrollRestoration is set to
     "manual" for the pinned hero, so the browser will not do this itself.
     ------------------------------------------------------------------------ */
  (function returnToPosition() {
    const KEY_Y = "formcut:lastY";
    const KEY_RESTORE = "formcut:restore";

    // private-mode Safari throws on sessionStorage access, so probe once
    let store = null;
    try { store = window.sessionStorage; store.getItem(KEY_Y); } catch { return; }
    const write = (k, v) => { try { store.setItem(k, v); } catch { /* quota */ } };

    /* Capture phase: the page-transition handler calls preventDefault on
       these same clicks, and this has to record the position regardless. */
    document.addEventListener("click", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('a[href^="quote.html"]')) {
        write(KEY_Y, String(Math.round(window.scrollY)));
      } else if (e.target.closest("[data-restore]")) {
        write(KEY_RESTORE, "1");
      }
    }, true);

    if (!HAS_HERO) return; // only index.html has a position worth restoring

    let wanted = false;
    try {
      wanted = store.getItem(KEY_RESTORE) === "1";
      store.removeItem(KEY_RESTORE); // one-shot: a later plain visit starts at the top
    } catch { /* ignore */ }
    if (!wanted) return;

    const y = parseInt(store.getItem(KEY_Y) || "0", 10);
    if (!(y > 0)) return;

    /* Re-applied as the page settles: sections grow as images decode and
       fonts swap, so a single early scroll would land short. */
    const seek = () => window.scrollTo({ top: y, behavior: "instant" });
    seek();
    window.addEventListener("load", () => requestAnimationFrame(seek));
    document.fonts?.ready.then(() => requestAnimationFrame(seek));
  })();

  /* ------------------------------------------------------------------------
     CROSS-PAGE ANCHORS
     Arriving from quote.html on index.html#capabilities, the browser resolves
     the fragment before the 420vh hero and the panel heights are final, so it
     lands at the top instead. Re-seek once the page has actually settled.
     ------------------------------------------------------------------------ */
  if (location.hash.length > 1) {
    const seek = () => {
      let target = null;
      try { target = document.querySelector(location.hash); } catch { /* not a valid selector */ }
      if (!target) return;
      // instant, not smooth: this is a correction, not a navigation gesture
      target.scrollIntoView({ behavior: "auto", block: "start" });
    };
    window.addEventListener("load", () => requestAnimationFrame(seek));
    document.fonts?.ready.then(() => requestAnimationFrame(seek));
  }

  /* ------------------------------------------------------------------------
     PAGE TRANSITION - wipe between index.html and quote.html
     Built in JS so both pages get it without duplicating markup.
     ------------------------------------------------------------------------ */
  (function pageTransition() {
    if (REDUCED) return;

    const veil = document.createElement("div");
    veil.className = "page-veil";
    veil.setAttribute("aria-hidden", "true");
    veil.innerHTML = '<span class="page-veil-mark">FORMCUT</span>';
    document.body.appendChild(veil);

    // wipe away on arrival
    requestAnimationFrame(() => document.body.classList.add("is-entered"));

    const isInternalPage = (a) => {
      const href = a.getAttribute("href") || "";
      if (!/^(index|quote)\.html/.test(href)) return false;
      // let modified clicks and new-tab requests behave normally
      return a.target !== "_blank";
    };

    document.addEventListener("click", (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = e.target.closest("a");
      if (!link || !isInternalPage(link)) return;

      e.preventDefault();
      const dest = link.href;
      document.body.classList.remove("is-entered");
      document.body.classList.add("is-leaving");
      // matches the veil transition in CSS; fallback timer in case the
      // transitionend never fires (element removed, tab backgrounded)
      let done = false;
      const go = () => {
        if (done) return;
        done = true;
        window.location.href = dest;
      };
      veil.addEventListener("transitionend", go, { once: true });
      setTimeout(go, 700);
    });
  })();

  /* ------------------------------------------------------------------------
     MISC
     ------------------------------------------------------------------------ */
  document.getElementById("backToTop")?.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: REDUCED ? "auto" : "smooth" });
  });

  const yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());
})();
