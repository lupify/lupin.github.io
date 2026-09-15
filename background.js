/*
 * Ambient background simulations, on the CPU.
 *
 * Four of them, one picked at random per page load and switchable from the
 * toolbar.  They share everything that is not physics: the canvas, the grid and
 * its wrap-around index tables, the corner mask, the scroll parallax, the
 * theme palette and the frame loop.  Each simulation supplies its own grid
 * resolution, step rate, blur and step/render pair.
 *
 *   turbulence   2D Navier-Stokes in vorticity-streamfunction form, forced by
 *                a band of Fourier modes with stochastic amplitudes
 *   shallow      the shallow water equations on a torus, lightly forced
 *   convection   Rayleigh-Benard: buoyancy-driven flow between a hot floor and
 *                a cold ceiling
 *   life         Conway's Game of Life, with cells fading as they die
 *
 * The two that need a streamfunction share one multigrid Poisson solver.  It
 * is the reason they read as flows rather than as noise: Gauss-Seidel on a
 * single grid clears high-frequency error quickly but barely touches the
 * smooth, large-scale part, and the large scales are exactly what the eye
 * sees.  Measured on this grid, 28 single-grid sweeps left the residual at
 * 114% of where it started; one V-cycle cuts it to 6.6%.
 */
(function () {
  'use strict';

  var canvas = document.getElementById('field');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) { console.warn('[background] disabled: no 2d context'); return; }

  // ---- shared tunables ---------------------------------------------------
  var PARALLAX = 0.12, PARALLAX_EASE = 0.075;

  // The field is strongest at the top right and fades to nothing toward the
  // left and the bottom, measured as distance from that corner along the
  // diagonal: 0 at the corner, 1 at the bottom left.
  var MASK_NEAR = 0.06, MASK_FAR = 0.92;

  var EDGE_LIGHT = 0.45, EDGE_DARK = 0.0, EDGE_GAIN = 9.0;
  // #noedge turns the light-mode outlines off, for comparing against them
  if (location.hash.indexOf('noedge') >= 0) EDGE_LIGHT = 0;
  var CONTOUR_WIDTH = 0.16;   // how wide an iso-line is drawn, in level units

  // Opacity is set against a contrast budget, not by eye, and allows for the
  // purple lobe of the page's CSS glow peaking in the same top-right corner --
  // the two stack there.  Dark is the easy case: the field is darker than the
  // glow-lit background, so it darkens and light text gains.  Light is tight,
  // and contrast there is paid for in luminance rather than saturation, which
  // is why its tints are light but strongly saturated.
  var PALETTE = {
    dark:  { pos: [58, 26, 36],    neg: [8, 7, 11],      alpha: 0.26,
             edge: [0, 0, 0],        strength: EDGE_DARK },
    light: { pos: [255, 147, 181],  neg: [167, 148, 247], alpha: 0.24,
             edge: [169, 154, 163],  strength: EDGE_LIGHT }
  };

  var narrow = window.innerWidth < 760;
  var WARM_BUDGET_MS = 7;     // per frame, so warming up never janks the page
  var now = (typeof performance !== 'undefined' && performance.now)
    ? function () { return performance.now(); } : Date.now;

  function animOn() { return document.documentElement.dataset.anim !== 'off'; }

  // ---- shell state -------------------------------------------------------
  var NX, NY, N, ASPECT, img, px, sim = null, simTime = 0;
  var XM, XP, YM, YP, MASK;

  function roundTo8(v) { return Math.max(24, Math.round(v / 8) * 8); }

  function buildWrap() {
    XM = new Int32Array(NX); XP = new Int32Array(NX);
    YM = new Int32Array(NY); YP = new Int32Array(NY);
    for (var x = 0; x < NX; x++) { XM[x] = (x - 1 + NX) % NX; XP[x] = (x + 1) % NX; }
    for (var y = 0; y < NY; y++) { YM[y] = (y - 1 + NY) % NY; YP[y] = (y + 1) % NY; }
  }

  // Distance from the top-right corner, smoothstepped.  Row 0 of the image is
  // the top of the canvas, so the corner is (x = NX-1, y = 0).  Precomputed:
  // it only changes on resize and would otherwise be a square root per pixel
  // per frame.
  function buildMask() {
    MASK = new Float32Array(NX * NY);
    var inv = 1 / Math.SQRT2;
    for (var y = 0; y < NY; y++) {
      var dv = y / Math.max(NY - 1, 1);
      for (var x = 0; x < NX; x++) {
        var du = 1 - x / Math.max(NX - 1, 1);
        var d = Math.sqrt(du * du + dv * dv) * inv;
        var t = (d - MASK_NEAR) / (MASK_FAR - MASK_NEAR);
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        MASK[y * NX + x] = 1 - t * t * (3 - 2 * t);
      }
    }
  }

  function allocate() {
    var aspect = Math.max(canvas.clientWidth, 1) / Math.max(canvas.clientHeight, 1);
    narrow = window.innerWidth < 760;          // re-read: phones rotate

    // Size by total cell count, not by width.  Fixing the width and letting the
    // height follow the aspect means a portrait phone builds a taller grid than
    // a desktop does -- measured, shallow water came out at 55,000 cells on a
    // phone against 46,000 on a desktop, i.e. more work on the weaker machine.
    // Deriving both dimensions from a cell budget keeps the cost the same
    // whichever way round the screen is.
    var budget = narrow ? sim.cellsNarrow : sim.cells;
    var nx = Math.sqrt(budget * aspect);
    // Only the multigrid solver needs dimensions it can halve three times.  The
    // others take the exact aspect, which matters most on a coarse grid where
    // rounding to the nearest eight would visibly stretch the cells.
    if (sim.needsPoisson) {
      NX = roundTo8(nx);
      NY = roundTo8(NX / aspect);
    } else {
      NX = Math.max(8, Math.round(nx));
      NY = Math.max(8, Math.round(NX / aspect));
    }
    N = NX * NY;
    ASPECT = NX / NY;

    buildWrap();
    buildMask();

    var cellPx = Math.max(canvas.clientWidth, 1) / NX;
    canvas.style.filter = 'blur(' + (sim.blur * cellPx).toFixed(2) + 'px)';
    canvas.width = NX; canvas.height = NY;
    img = ctx.createImageData(NX, NY);
    px = img.data;
    for (var i = 3; i < px.length; i += 4) px[i] = 255;

    if (sim.needsPoisson) buildLevels();
    sim.alloc();
    sim.seed();
    simTime = 0;
  }

  // ---- random Fourier modes ---------------------------------------------
  // cos(a+b) and sin(a+b) expand into products of per-axis terms, so a mode sum
  // costs two multiplies per cell with no transcendentals in the inner loop.
  // Folding the amplitudes into per-column P and Q first is what keeps a
  // stochastic, every-frame forcing affordable on the CPU.
  function gauss() { return (Math.random() + Math.random() + Math.random() - 1.5) * 1.4142; }

  function setWave(M, klo, khi) {
    var ang = Math.random() * 6.2831853, K = klo + (khi - klo) * Math.random();
    M.nx = Math.round(K * Math.cos(ang) * ASPECT);
    M.ny = Math.round(K * Math.sin(ang));
    if (M.nx === 0 && M.ny === 0) M.nx = 1;
    for (var x = 0; x < NX; x++) {
      var a = 6.2831853 * M.nx * (x + 0.5) / NX;
      M.ca[x] = Math.cos(a); M.sa[x] = Math.sin(a);
    }
    for (var y = 0; y < NY; y++) {
      var b = 6.2831853 * M.ny * (y + 0.5) / NY;
      M.cb[y] = Math.cos(b); M.sb[y] = Math.sin(b);
    }
  }

  function makeModes(n, klo, khi, randomAmp) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var M = { nx: 1, ny: 0, ar: 0, ai: 0, klo: klo, khi: khi,
                ca: new Float32Array(NX), sa: new Float32Array(NX),
                cb: new Float32Array(NY), sb: new Float32Array(NY),
                P: new Float32Array(NX), Q: new Float32Array(NX) };
      setWave(M, klo, khi);
      if (randomAmp) { M.ar = gauss(); M.ai = gauss(); }
      out.push(M);
    }
    return out;
  }

  // One Ornstein-Uhlenbeck step per mode: a random walk pulled back toward
  // zero.  Stationary variance is held at 1 so the caller's amplitude alone
  // sets the scale.  Quiet modes are also moved to fresh wavevectors, so the
  // forcing drifts in frequency as well as in amplitude, with no period.
  function driftModes(modes, tau, resampleP) {
    var theta = 1 / tau, sigma = Math.sqrt(2 * theta);
    for (var m = 0; m < modes.length; m++) {
      var M = modes[m];
      M.ar += -theta * M.ar + sigma * gauss();
      M.ai += -theta * M.ai + sigma * gauss();
      if (Math.random() < resampleP && M.ar * M.ar + M.ai * M.ai < 0.02) {
        setWave(M, M.klo, M.khi);
      }
    }
  }

  function evalModes(modes, out, amp) {
    out.fill(0);
    var norm = amp / Math.sqrt(2 * modes.length);
    for (var m = 0; m < modes.length; m++) {
      var M = modes[m], ar = M.ar * norm, ai = M.ai * norm, x, y;
      var ca = M.ca, sa = M.sa, cb = M.cb, sb = M.sb, P = M.P, Q = M.Q;
      for (x = 0; x < NX; x++) { P[x] = ar * ca[x] + ai * sa[x]; Q[x] = ai * ca[x] - ar * sa[x]; }
      for (y = 0; y < NY; y++) {
        var row = y * NX, cby = cb[y], sby = sb[y];
        for (x = 0; x < NX; x++) out[row + x] += P[x] * cby + Q[x] * sby;
      }
    }
  }

  // ---- multigrid Poisson -------------------------------------------------
  // Periodic in x always.  In y it is periodic for turbulence and Dirichlet
  // (psi = 0, a solid wall) for convection, which is what makes the floor and
  // ceiling real boundaries rather than a wrap-around.
  var levels = [], wallY = false;
  var VCYCLES = 1, PRE = 2, POST = 2, COARSE_ITERS = 24;

  function buildLevels() {
    levels = [];
    var w = NX, h = NY, hh = 1;
    for (var l = 0; l < 4; l++) {
      levels.push({ w: w, h: h, h2: hh * hh,
                    u: new Float32Array(w * h), f: new Float32Array(w * h),
                    r: new Float32Array(w * h) });
      if (w % 2 || h % 2) break;
      w >>= 1; h >>= 1; hh *= 2;
    }
  }

  function removeMean(a) {
    var s = 0, i;
    for (i = 0; i < a.length; i++) s += a[i];
    s /= a.length;
    for (i = 0; i < a.length; i++) a[i] -= s;
  }

  // Red-black Gauss-Seidel: each colour only reads the other, so a sweep is
  // order-independent and converges about twice as fast as damped Jacobi.
  function smooth(L, iters) {
    var w = L.w, h = L.h, u = L.u, f = L.f, h2 = L.h2;
    for (var it = 0; it < iters; it++) {
      for (var color = 0; color < 2; color++) {
        for (var y = 0; y < h; y++) {
          var top = y === 0, bot = y + 1 === h;
          var yn = (top ? h - 1 : y - 1) * w, yp = (bot ? 0 : y + 1) * w, row = y * w;
          for (var x = (y + color) & 1; x < w; x += 2) {
            var xn = x === 0 ? w - 1 : x - 1, xp = x + 1 === w ? 0 : x + 1;
            var up = (wallY && top) ? 0 : u[yn + x];
            var dn = (wallY && bot) ? 0 : u[yp + x];
            u[row + x] = 0.25 * (u[row + xn] + u[row + xp] + up + dn - h2 * f[row + x]);
          }
        }
      }
    }
  }

  function residual(L) {
    var w = L.w, h = L.h, u = L.u, f = L.f, r = L.r, inv = 1 / L.h2;
    for (var y = 0; y < h; y++) {
      var top = y === 0, bot = y + 1 === h;
      var yn = (top ? h - 1 : y - 1) * w, yp = (bot ? 0 : y + 1) * w, row = y * w;
      for (var x = 0; x < w; x++) {
        var xn = x === 0 ? w - 1 : x - 1, xp = x + 1 === w ? 0 : x + 1;
        var up = (wallY && top) ? 0 : u[yn + x];
        var dn = (wallY && bot) ? 0 : u[yp + x];
        r[row + x] = f[row + x] - (u[row + xn] + u[row + xp] + up + dn - 4 * u[row + x]) * inv;
      }
    }
  }

  function restrict(fine, coarse) {
    var fw = fine.w, cw = coarse.w, ch = coarse.h, src = fine.r, dst = coarse.f;
    for (var y = 0; y < ch; y++) {
      var r0 = (2 * y) * fw, r1 = (2 * y + 1) * fw;
      for (var x = 0; x < cw; x++) {
        var c0 = 2 * x, c1 = 2 * x + 1;
        dst[y * cw + x] = 0.25 * (src[r0 + c0] + src[r0 + c1] + src[r1 + c0] + src[r1 + c1]);
      }
    }
    coarse.u.fill(0);
    // A fully periodic Laplacian is singular: it has no solution unless the
    // right-hand side averages to zero.  With a wall in y it is not singular
    // and the mean must be left alone.
    if (!wallY) removeMean(dst);
  }

  function prolongAdd(coarse, fine) {
    var cw = coarse.w, ch = coarse.h, fw = fine.w, fh = fine.h, src = coarse.u, dst = fine.u;
    for (var y = 0; y < fh; y++) {
      var gy = (y - 0.5) * 0.5, y0 = Math.floor(gy), ty = gy - y0, ya, yb;
      if (wallY) {
        ya = y0 < 0 ? 0 : (y0 > ch - 1 ? ch - 1 : y0);
        yb = y0 + 1 < 0 ? 0 : (y0 + 1 > ch - 1 ? ch - 1 : y0 + 1);
      } else {
        ya = ((y0 % ch) + ch) % ch; yb = (ya + 1) % ch;
      }
      for (var x = 0; x < fw; x++) {
        var gx = (x - 0.5) * 0.5, x0 = Math.floor(gx), tx = gx - x0;
        var xa = ((x0 % cw) + cw) % cw, xb = (xa + 1) % cw;
        dst[y * fw + x] +=
          (src[ya * cw + xa] * (1 - tx) + src[ya * cw + xb] * tx) * (1 - ty) +
          (src[yb * cw + xa] * (1 - tx) + src[yb * cw + xb] * tx) * ty;
      }
    }
  }

  function vcycle(l) {
    var L = levels[l];
    if (l === levels.length - 1) {
      smooth(L, COARSE_ITERS);
      if (!wallY) removeMean(L.u);
      return;
    }
    smooth(L, PRE);
    residual(L);
    restrict(L, levels[l + 1]);
    vcycle(l + 1);
    prolongAdd(levels[l + 1], L);
    smooth(L, POST);
  }

  function solvePoisson(src, psi) {
    var L = levels[0], i;
    for (i = 0; i < N; i++) L.f[i] = -src[i];
    if (!wallY) removeMean(L.f);
    L.u.set(psi);                       // warm start from the previous step
    for (i = 0; i < VCYCLES; i++) vcycle(0);
    if (!wallY) removeMean(L.u);
    psi.set(L.u);
  }

  // ---- sampling and advection -------------------------------------------
  function sampleWrap(f, x, y) {
    var x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
    var xa = x0, ya = y0;
    while (xa < 0) xa += NX;  while (xa >= NX) xa -= NX;
    while (ya < 0) ya += NY;  while (ya >= NY) ya -= NY;
    var xb = xa + 1 === NX ? 0 : xa + 1, yb = ya + 1 === NY ? 0 : ya + 1;
    var ra = ya * NX, rb = yb * NX;
    return (f[ra + xa] * (1 - tx) + f[ra + xb] * tx) * (1 - ty) +
           (f[rb + xa] * (1 - tx) + f[rb + xb] * tx) * ty;
  }

  // Wraps in x, clamps in y.  Wrapping the vertical would let the hot floor
  // leak into the cold ceiling.
  function sampleWall(f, x, y) {
    var x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
    var xa = x0;
    while (xa < 0) xa += NX;  while (xa >= NX) xa -= NX;
    var xb = xa + 1 === NX ? 0 : xa + 1;
    var ya = y0 < 0 ? 0 : (y0 > NY - 1 ? NY - 1 : y0);
    var yb = y0 + 1 < 0 ? 0 : (y0 + 1 > NY - 1 ? NY - 1 : y0 + 1);
    var ra = ya * NX, rb = yb * NX;
    return (f[ra + xa] * (1 - tx) + f[ra + xb] * tx) * (1 - ty) +
           (f[rb + xa] * (1 - tx) + f[rb + xb] * tx) * ty;
  }

  var velX = null, velY = null, fwdA = null, fwdB = null;

  var tmpA = null;

  function ensureFlowBuffers() {
    if (velX && velX.length === N) return;
    velX = new Float32Array(N); velY = new Float32Array(N);
    fwdA = new Float32Array(N); fwdB = new Float32Array(N);
    tmpA = new Float32Array(N);
  }

  function velocityFrom(psi) {
    for (var y = 0; y < NY; y++) {
      var yn = YM[y] * NX, yp = YP[y] * NX, row = y * NX;
      for (var x = 0; x < NX; x++) {
        velX[row + x] = 0.5 * (psi[yp + x] - psi[yn + x]);        //  u =  d(psi)/dy
        velY[row + x] = -0.5 * (psi[row + XP[x]] - psi[row + XM[x]]); //  v = -d(psi)/dx
      }
    }
  }

  // MacCormack: advect forward, advect that back, and correct by half the
  // round-trip error.  Plain semi-Lagrangian is strongly low-pass and would
  // smooth the field flat within seconds.  The clamp to the local range is what
  // stops the correction ringing -- without it the anti-diffusive term grows
  // without bound.
  function advect(src, dst, dt, samp) {
    var x, y, i;
    for (y = 0; y < NY; y++)
      for (x = 0; x < NX; x++) {
        i = y * NX + x;
        fwdA[i] = samp(src, x - dt * velX[i], y - dt * velY[i]);
      }
    for (y = 0; y < NY; y++)
      for (x = 0; x < NX; x++) {
        i = y * NX + x;
        fwdB[i] = samp(fwdA, x + dt * velX[i], y + dt * velY[i]);
      }
    for (y = 0; y < NY; y++) {
      var yn = YM[y] * NX, yp = YP[y] * NX, row = y * NX;
      for (x = 0; x < NX; x++) {
        i = row + x;
        var c = fwdA[i] + 0.5 * (src[i] - fwdB[i]);
        var a = src[i], b = src[row + XM[x]], cc = src[row + XP[x]],
            d = src[yn + x], e = src[yp + x];
        var lo = a < b ? a : b; if (cc < lo) lo = cc; if (d < lo) lo = d; if (e < lo) lo = e;
        var hi = a > b ? a : b; if (cc > hi) hi = cc; if (d > hi) hi = d; if (e > hi) hi = e;
        dst[i] = c < lo ? lo : (c > hi ? hi : c);
      }
    }
  }

  function laplacian(f, i, x, y, row, yn, yp) {
    return f[row + XM[x]] + f[row + XP[x]] + f[yn + x] + f[yp + x] - 4 * f[i];
  }

  // ---- pointer stirring --------------------------------------------------
  var stirPos = [0.5, 0.5], stirVel = [0, 0], stirAmp = 0, lastPtr = null;
  var STIR_RADIUS = 0.075, STIR_AMP = 0.55, STIR_DECAY = 0.86;

  window.addEventListener('pointermove', function (e) {
    var x = e.clientX / window.innerWidth, y = 1 - e.clientY / window.innerHeight;
    if (lastPtr) {
      var dx = x - lastPtr[0], dy2 = y - lastPtr[1], sp = Math.sqrt(dx * dx + dy2 * dy2);
      if (sp > 0.0002) {
        stirVel[0] += (dx - stirVel[0]) * 0.35;
        stirVel[1] += (dy2 - stirVel[1]) * 0.35;
        stirAmp = Math.min(1, stirAmp + sp * 14);
      }
    }
    stirPos[0] = x; stirPos[1] = y + scrollNow;
    lastPtr = [x, y];
  }, { passive: true });

  // The curl of a Gaussian force field v*G(d) is proportional to G(d)*cross(d,v),
  // so a moving pointer leaves a vortex dipole -- two counter-rotating lobes,
  // the signature of something dragged through a fluid rather than paint
  // dropped in.  Only cells inside the blob are touched.
  function applyStir(field, scale) {
    if (stirAmp < 0.002) return;
    var cx = stirPos[0] * NX, cy = (1 - (stirPos[1] - Math.floor(stirPos[1]))) * NY;
    var rx = STIR_RADIUS * NX, ry = STIR_RADIUS * NY;
    var x0 = Math.floor(cx - 2 * rx), x1 = Math.ceil(cx + 2 * rx);
    var y0 = Math.floor(cy - 2 * ry), y1 = Math.ceil(cy + 2 * ry);
    var amp = stirAmp * STIR_AMP * scale, vx = stirVel[0] * NX, vy = stirVel[1] * NY;
    for (var y = y0; y <= y1; y++) {
      if (y < 0 || y >= NY) continue;
      var row = y * NX, dyc = (y - cy) / ry;
      for (var x = x0; x <= x1; x++) {
        var xx = ((x % NX) + NX) % NX, dxc = (x - cx) / rx;
        var g = Math.exp(-(dxc * dxc + dyc * dyc));
        field[row + xx] += amp * g * (vy * dxc - vx * dyc) * 0.02;
      }
    }
  }

  // ======================================================================
  // Simulations
  // ======================================================================

  // Forcing and damping decide how a flow behaves, but between them they are a
  // poor way to pin its overall level: stochastic forcing equilibrates over
  // minutes and with enough variance that halving the forcing barely moved
  // where it ended up, and the shallow water layer kept climbing for as long as
  // it was watched.  The level is held directly instead, by nudging the whole
  // field toward a target rms a fraction of a percent per step.  Uniform
  // scaling changes amplitude, not structure.
  var LEVEL_RATE = 0.02, LEVEL_CLAMP = 0.02;

  function level(rms, target) {
    if (!(rms > 1e-6)) return 1;
    var k = 1 + LEVEL_RATE * (target / rms - 1);
    return k < 1 - LEVEL_CLAMP ? 1 - LEVEL_CLAMP : (k > 1 + LEVEL_CLAMP ? 1 + LEVEL_CLAMP : k);
  }

  // ---- 1. forced 2D turbulence ------------------------------------------
  var TURB = (function () {
    var DT = 0.204, ADVECT = 2.6 * DT;
    var DISSIPATE = 1 - 0.0010 * DT;
    var SEED_AMP = 0.30, SEED_KLO = 1.0, SEED_KHI = 3.0, SEED_N = 32;
    var FORCE_N = 10, FORCE_KLO = 5.0, FORCE_KHI = 11.0;
    var FORCE_AMP = 0.030 * DT, FORCE_TAU = 150, FORCE_EVERY = 2, RESAMPLE_P = 0.02;
    var TARGET_OM = 0.22, TARGET_DY = 0.50;
    var DYE_N = 8, DYE_KLO = 2.0, DYE_KHI = 5.0;
    var DYE_AMP = 0.13 * DT, DYE_DECAY = 1 - 0.0016 * DT, DYE_GAIN = 1.7;

    var om, dy, psi, forceF, dyeF, seedModes, forceModes, dyeModes;

    return {
      label: 'Turbulence', needsPoisson: true, wallY: false, parallax: true,
      cells: 70400, cellsNarrow: 26000, blur: 1.15, stepHz: 20,

      alloc: function () {
        om = new Float32Array(N); dy = new Float32Array(N); psi = new Float32Array(N);
        forceF = new Float32Array(N); dyeF = new Float32Array(N);
        ensureFlowBuffers();
      },
      seed: function () {
        seedModes = makeModes(SEED_N, SEED_KLO, SEED_KHI, true);
        forceModes = makeModes(FORCE_N, FORCE_KLO, FORCE_KHI, true);
        dyeModes = makeModes(DYE_N, DYE_KLO, DYE_KHI, true);
        evalModes(seedModes, om, SEED_AMP);
        evalModes(dyeModes, dy, 0.5);
        psi.fill(0);
      },
      // The dye shows where the flow has been; the vortices themselves live in
      // the vorticity, so that is what the outlines trace.
      render: function () {
        renderScalar(dy, DYE_GAIN, 0, null, { src: om, gain: 26 });
      },
      stats: function () {
        var so = 0, sd = 0, c = 0;
        for (var i = 0; i < N; i += 8) { so += om[i] * om[i]; sd += dy[i] * dy[i]; c++; }
        return 'om ' + Math.sqrt(so / c).toFixed(3) + '  dye ' + Math.sqrt(sd / c).toFixed(3);
      },

      step: function () {
        solvePoisson(om, psi);
        velocityFrom(psi);

        advect(om, tmpA, ADVECT, sampleWrap); om.set(tmpA);
        advect(dy, tmpA, ADVECT, sampleWrap); dy.set(tmpA);

        simTime++;
        driftModes(forceModes, FORCE_TAU, RESAMPLE_P);
        driftModes(dyeModes, FORCE_TAU, RESAMPLE_P);
        if (simTime % FORCE_EVERY === 0) {
          evalModes(forceModes, forceF, FORCE_AMP * FORCE_EVERY);
          evalModes(dyeModes, dyeF, DYE_AMP * FORCE_EVERY);
        }

        var so = 0, sd = 0, cnt = 0, i;
        for (i = 0; i < N; i += 8) { so += om[i] * om[i]; sd += dy[i] * dy[i]; cnt++; }
        var ko = level(Math.sqrt(so / cnt), TARGET_OM) * DISSIPATE;
        var kd = level(Math.sqrt(sd / cnt), TARGET_DY) * DYE_DECAY;

        if (simTime % FORCE_EVERY === 0) {
          for (i = 0; i < N; i++) { om[i] = om[i] * ko + forceF[i]; dy[i] = dy[i] * kd + dyeF[i]; }
        } else {
          for (i = 0; i < N; i++) { om[i] *= ko; dy[i] *= kd; }
        }
        applyStir(om, 1);
      }
    };
  })();

  // ---- 2. shallow water on a torus --------------------------------------
  // h_t + div(h u) = 0,  u_t + (u.grad)u + g grad h = viscosity - drag.
  // Centred differences on a periodic grid, explicit in time.  The domain
  // wraps in both directions, so waves that leave one edge arrive at the
  // other and there are no reflections anywhere.
  var SWE = (function () {
    var G = 1.0, H0 = 1.0, DT = 0.22;
    var VISC = 0.06;          // needed: centred advection alone is unstable
    var DRAG = 0.0009;
    var F_N = 8, F_KLO = 1.5, F_KHI = 4.5;
    var F_AMP = 0.0016, F_TAU = 110, F_RESAMPLE = 0.03;
    var GAIN = 11.0, TARGET_H = 0.055;

    var h, u, v, hn, un, vn, force, modes;

    return {
      label: 'Shallow water', needsPoisson: false, wallY: false, parallax: true,
      cells: 46656, cellsNarrow: 18000, blur: 1.15, stepHz: 30,

      alloc: function () {
        h = new Float32Array(N); u = new Float32Array(N); v = new Float32Array(N);
        hn = new Float32Array(N); un = new Float32Array(N); vn = new Float32Array(N);
        force = new Float32Array(N);
      },
      seed: function () {
        modes = makeModes(F_N, F_KLO, F_KHI, true);
        h.fill(H0); u.fill(0); v.fill(0);
        evalModes(modes, force, 0.05);
        for (var i = 0; i < N; i++) h[i] = H0 + force[i];
      },
      step: function () {
        simTime++;
        // The forcing is a handful of long-wavelength modes whose complex
        // amplitudes random-walk and whose wavevectors are occasionally
        // resampled, so both how hard it pushes and at what scale drift with
        // no period to them.
        driftModes(modes, F_TAU, F_RESAMPLE);
        evalModes(modes, force, F_AMP);

        var x, y, i, row, yn, yp, xm, xp;
        for (y = 0; y < NY; y++) {
          row = y * NX; yn = YM[y] * NX; yp = YP[y] * NX;
          for (x = 0; x < NX; x++) {
            i = row + x; xm = XM[x]; xp = XP[x];
            var hE = h[row + xp], hW = h[row + xm], hN = h[yn + x], hS = h[yp + x];
            var uE = u[row + xp], uW = u[row + xm], uN = u[yn + x], uS = u[yp + x];
            var vE = v[row + xp], vW = v[row + xm], vN = v[yn + x], vS = v[yp + x];

            var divH = 0.5 * ((hE * uE - hW * uW) + (hS * vS - hN * vN));
            var dhdx = 0.5 * (hE - hW), dhdy = 0.5 * (hS - hN);
            var dudx = 0.5 * (uE - uW), dudy = 0.5 * (uS - uN);
            var dvdx = 0.5 * (vE - vW), dvdy = 0.5 * (vS - vN);

            var lapH = hE + hW + hN + hS - 4 * h[i];
            var lapU = uE + uW + uN + uS - 4 * u[i];
            var lapV = vE + vW + vN + vS - 4 * v[i];

            hn[i] = h[i] + DT * (-divH) + VISC * lapH + force[i];
            un[i] = u[i] + DT * (-(u[i] * dudx + v[i] * dudy) - G * dhdx)
                    + VISC * lapU - DRAG * u[i];
            vn[i] = v[i] + DT * (-(u[i] * dvdx + v[i] * dvdy) - G * dhdy)
                    + VISC * lapV - DRAG * v[i];
          }
        }
        h.set(hn); u.set(un); v.set(vn);

        // A depth that reaches zero would make the wave speed imaginary and the
        // scheme blow up, so the layer is kept firmly positive.
        for (i = 0; i < N; i++) if (h[i] < 0.35) h[i] = 0.35;

        // Hold the wave amplitude.  Left to the forcing and the drag alone it
        // climbed steadily for as long as it was measured.  Scaling the
        // velocities by the same factor keeps them consistent with the surface.
        var sh = 0;
        for (i = 0; i < N; i++) { var d = h[i] - H0; sh += d * d; }
        var k = level(Math.sqrt(sh / N), TARGET_H);
        if (k !== 1) {
          for (i = 0; i < N; i++) {
            h[i] = H0 + (h[i] - H0) * k;
            u[i] *= k; v[i] *= k;
          }
        }
      },
      // Iso-lines of the surface, which rise into view and flatten away again
      // as the waves pass, the way contours do on a moving chart.
      render: function () {
        renderScalar(h, GAIN, H0, null, { mode: 'contour', levels: 26 });
      },
      stats: function () {
        var sh = 0, sv = 0, hmin = 1e9, hmax = -1e9;
        for (var i = 0; i < N; i++) {
          var d = h[i] - H0; sh += d * d; sv += u[i] * u[i] + v[i] * v[i];
          if (h[i] < hmin) hmin = h[i];
          if (h[i] > hmax) hmax = h[i];
        }
        return 'h rms ' + Math.sqrt(sh / N).toFixed(4) + '  h ' + hmin.toFixed(2) + '-' +
               hmax.toFixed(2) + '  |u| ' + Math.sqrt(sv / N).toFixed(3);
      }
    };
  })();

  // ---- 3. Rayleigh-Benard convection ------------------------------------
  // Boussinesq: temperature is advected and diffused, and horizontal
  // temperature gradients torque the fluid.  Hot floor, cold ceiling, walls
  // top and bottom, periodic left to right.
  var RBC = (function () {
    var DT = 0.9, BUOY = 0.05, VISC = 0.07, KAPPA = 0.05;
    var GAIN = 9.0;
    var DRAG = 0.004;      // keeps the rolls from running away

    var T, om, psi, tmp, rowMean;

    return {
      label: 'Convection', needsPoisson: true, wallY: true,
      // The floor is the bottom row of the grid and the grid is sized to the
      // viewport, so the aspect the rolls form in -- and how many of them fit
      // across -- follows the screen it is drawn on.
      parallax: false,
      cells: 46080, cellsNarrow: 18000, blur: 1.0, stepHz: 24, warmup: 400,

      alloc: function () {
        T = new Float32Array(N); om = new Float32Array(N); psi = new Float32Array(N);
        tmp = new Float32Array(N); rowMean = new Float32Array(NY);
        ensureFlowBuffers();
      },
      seed: function () {
        for (var y = 0; y < NY; y++) {
          var base = 1 - y / (NY - 1);            // 1 at the floor, 0 at the ceiling
          for (var x = 0; x < NX; x++)
            T[y * NX + x] = base + (Math.random() - 0.5) * 0.30;
        }
        om.fill(0); psi.fill(0);
      },
      step: function () {
        simTime++;
        solvePoisson(om, psi);
        velocityFrom(psi);

        advect(om, tmp, DT, sampleWall); om.set(tmp);
        advect(T, tmp, DT, sampleWall); T.set(tmp);

        var x, y, i, row, yn, yp;
        for (y = 0; y < NY; y++) {
          row = y * NX; yn = YM[y] * NX; yp = YP[y] * NX;
          for (x = 0; x < NX; x++) {
            i = row + x;
            // Buoyancy enters the vorticity equation as the horizontal
            // temperature gradient: warm fluid beside cold fluid is a torque.
            // The sign matters and is easy to get backwards -- inverted, the
            // layer stratifies stably and nothing ever moves.  With y measured
            // downward from the top of the screen the body force on warm fluid
            // is -beta*T in y, so the vorticity source is -beta * dT/dx.
            var dTdx = 0.5 * (T[row + XP[x]] - T[row + XM[x]]);
            om[i] += -DT * BUOY * dTdx + VISC * laplacian(om, i, x, y, row, yn, yp)
                     - DRAG * om[i];
            T[i] += KAPPA * laplacian(T, i, x, y, row, yn, yp);
          }
        }

        // Fixed plates, and no vorticity generated at the walls themselves.
        for (x = 0; x < NX; x++) {
          T[x] = 0;                       // cold ceiling
          T[(NY - 1) * NX + x] = 1;       // hot floor
          om[x] *= 0.5;
          om[(NY - 1) * NX + x] *= 0.5;
        }
        applyStir(om, 0.35);
      },
      render: function () {
        // Convection mixes the bulk to nearly one temperature and leaves thin
        // layers at the plates, which is correct physics but almost blank to
        // look at.  Drawing each cell against the mean at its own height shows
        // the plumes instead, which is what the motion actually is.
        for (var y = 0; y < NY; y++) {
          var row = y * NX, s = 0;
          for (var x = 0; x < NX; x++) s += T[row + x];
          rowMean[y] = s / NX;
        }
        // Steep temperature gradients are exactly the edges of the plumes.
        renderScalar(T, GAIN, 0, rowMean, { src: T, gain: 19 });
      },
      stats: function () {
        var flux = 0, w2 = 0;
        for (var y = 1; y < NY - 1; y++) {
          var row = y * NX;
          for (var x = 0; x < NX; x++) {
            var vy = -velY[row + x];          // screen y grows downward
            flux += vy * (T[row + x] - rowMean[y]);
            w2 += vy * vy;
          }
        }
        var an = 0;
        for (y = 0; y < NY; y++) {
          var r2 = y * NX;
          for (var x2 = 0; x2 < NX; x2++) { var d = T[r2 + x2] - rowMean[y]; an += d * d; }
        }
        return 'heat flux ' + (flux / N).toFixed(4) +
               '  |w| ' + Math.sqrt(w2 / N).toFixed(3) +
               '  anomaly ' + Math.sqrt(an / N).toFixed(4);
      }
    };
  })();

  // ---- 4. Conway's Game of Life -----------------------------------------
  // Everything visual here is measured in generations rather than in steps, and
  // advanced a fraction of a generation per frame.  A cell is not simply on or
  // off: it rises over two generations while it lives, and when it dies it
  // fades from wherever it had got to, so a cell that only lasted one
  // generation never reaches full strength and its ghost is correspondingly
  // fainter.  That is what stops a board of blinkers strobing.
  var LIFE = (function () {
    var FADE = 15;                 // generations from death to invisible
    var RISE = 2;                  // generations from birth to full strength
    var TARGET_DENSITY = 0.055;    // what counts as a healthy population
    var ACTIVITY_FULL = 0.035;     // activity at which spawning stops entirely
    var SPAWN_MAX = 0.0022;        // cells per cell per step, at most
    var SPAWN_SPREAD = 0.5;        // generations over which a batch is released
    var HOLD = 0.22;               // where maroon sits on the red-to-purple ramp
    var SEED_THRESHOLD = 0.45;     // where the smooth field counts as "busy"
    var SEED_SOFT = 0.35;          // how abrupt that boundary is
    var SEED_QUIET = 0.02, SEED_BUSY = 0.34;   // density either side of it
    // Discrete cells read as louder than a smooth field at the same opacity --
    // they are hard-edged and all at full strength at once -- so dark mode
    // pulls them down further than light, where the page can carry more.
    var ALPHA_DARK = 0.52, ALPHA_LIGHT = 0.92;

    var LIVE = [214, 61, 61];      // red
    var DEAD_NEW = [138, 42, 66];  // maroon, just died
    var DEAD_OLD = [104, 74, 176]; // purple, about to vanish

    // Two continuous quantities per cell, and nothing is ever reset.  `lvl` is
    // brightness and `dead` is how far the colour has travelled from red toward
    // purple.  Being born reverses both rather than restarting them, so a cell
    // that lights up on a square whose ghost is still fading rises from that
    // ghost's brightness instead of dropping to nothing first -- which is what
    // made births flash.
    var cells, next, lvl, dead, deadA;
    var lastRate = 0, pending = 0, releaseRate = 0;

    function spawnBlob() {
      var cx = (Math.random() * NX) | 0, cy = (Math.random() * NY) | 0;
      for (var j = 0; j < 3; j++)
        for (var i = 0; i < 3; i++) {
          if (Math.random() > 0.55) continue;
          var x = (cx + i) % NX, y = (cy + j) % NY, k = y * NX + x;
          if (cells[k]) continue;
          cells[k] = 1;             // brightness carries on from wherever it is
        }
    }

    return {
      label: "Conway's Life", needsPoisson: false, wallY: false, parallax: true,
      cells: 1300, cellsNarrow: 900,   // 2.5x coarser than the first version
      blur: 0.34,                  // crisper than the continuous fields
      stepHz: 3,                   // generations a second
      renderHz: 20,                // ten frames to a generation

      alloc: function () {
        cells = new Uint8Array(N); next = new Uint8Array(N);
        lvl = new Float32Array(N); dead = new Float32Array(N); deadA = new Float32Array(N);
      },
      seed: function () {
        // Not uniform noise: a handful of long-wavelength modes make a smooth
        // field, that field is thresholded into "busy" and "quiet" regions, and
        // cells are then thrown down at random within them.  A uniformly random
        // start looks the same everywhere and settles into the same debris
        // everywhere; clumps give it somewhere to happen.
        var m = makeModes(6, 0.8, 2.6, true), f = new Float32Array(N), i;
        evalModes(m, f, 1.0);
        var lo = Infinity, hi = -Infinity;
        for (i = 0; i < N; i++) { if (f[i] < lo) lo = f[i]; if (f[i] > hi) hi = f[i]; }
        var span = (hi - lo) || 1;

        for (i = 0; i < N; i++) {
          var u = (f[i] - lo) / span;                 // 0..1 across the field
          var t = (u - SEED_THRESHOLD) / SEED_SOFT;   // soft threshold
          t = t < 0 ? 0 : (t > 1 ? 1 : t);
          var p = SEED_QUIET + (SEED_BUSY - SEED_QUIET) * t * t * (3 - 2 * t);
          cells[i] = Math.random() < p ? 1 : 0;
          lvl[i] = cells[i] ? 1 : 0;
          dead[i] = cells[i] ? 0 : 1;
          deadA[i] = 0;
        }
        pending = 0; releaseRate = 0;
      },

      step: function () {
        simTime++;
        var x, y, i, row, yn, yp, pop = 0, changed = 0;
        for (y = 0; y < NY; y++) {
          row = y * NX; yn = YM[y] * NX; yp = YP[y] * NX;
          for (x = 0; x < NX; x++) {
            i = row + x;
            var xm = XM[x], xp = XP[x];
            var n = cells[row + xm] + cells[row + xp] +
                    cells[yn + xm] + cells[yn + x] + cells[yn + xp] +
                    cells[yp + xm] + cells[yp + x] + cells[yp + xp];
            var alive = cells[i];
            var out = (n === 3 || (alive === 1 && n === 2)) ? 1 : 0;
            next[i] = out;
            if (out) pop++;
            if (out !== alive) changed++;
          }
        }

        for (i = 0; i < N; i++) {
          var was = cells[i], now = next[i];
          // Only the death transition records anything: how bright the cell was
          // when it died sets how fast it fades, so the ghost always takes the
          // same number of generations to vanish whatever height it fell from.
          if (!now && was) deadA[i] = lvl[i] > 0.02 ? lvl[i] : 0.02;
          cells[i] = now;
        }

        // Left alone, a random field settles into still lifes and blinkers and
        // stops being interesting.  Spawning opens up when the population thins
        // and closes as soon as something is happening, so the board is only
        // seeded once it has gone quiet.
        var density = pop / N, activity = changed / N;
        var want = (TARGET_DENSITY - density) / TARGET_DENSITY;
        want = want < 0 ? 0 : (want > 1 ? 1 : want);
        var calm = 1 - activity / ACTIVITY_FULL;
        calm = calm < 0 ? 0 : (calm > 1 ? 1 : calm);
        lastRate = SPAWN_MAX * want * calm;

        // Queued rather than placed here: a generation's worth of new cells
        // arriving in one instant is what made spawning pop.
        pending += lastRate * N / 4.5;                    // each blob is ~4.5 cells
        releaseRate = pending / (SPAWN_SPREAD / this.stepHz);
      },

      // Per animation frame.  Both fades run on wall-clock time, measured in
      // generations, so they are smooth however many frames fall in a step.
      frame: function (dtSec) {
        var gen = dtSec * this.stepHz, busy = false, i;

        if (pending > 0) {
          var due = releaseRate * dtSec;
          if (due > pending) due = pending;
          var whole = Math.floor(due);
          for (var b = 0; b < whole; b++) { spawnBlob(); pending -= 1; }
          if (pending > 0 && Math.random() < due - whole) { spawnBlob(); pending -= 1; }
          if (pending < 0.0001) pending = 0;
          busy = true;
        }

        var rise = gen / RISE, hue = gen / FADE;
        for (i = 0; i < N; i++) {
          if (cells[i]) {
            if (lvl[i] < 1 || dead[i] > 0) {
              lvl[i] += rise;  if (lvl[i] > 1) lvl[i] = 1;
              dead[i] -= rise; if (dead[i] < 0) dead[i] = 0;
              busy = true;
            }
          } else if (lvl[i] > 0) {
            lvl[i] -= gen * deadA[i] / FADE; if (lvl[i] < 0) lvl[i] = 0;
            dead[i] += hue;                  if (dead[i] > 1) dead[i] = 1;
            busy = true;
          }
        }
        return busy;
      },

      stats: function () {
        var pop = 0;
        for (var i = 0; i < N; i++) pop += cells[i];
        return 'pop ' + (100 * pop / N).toFixed(2) + '%  spawn ' + lastRate.toExponential(1) +
               '  queued ' + pending.toFixed(2);
      },

      render: function () {
        var alpha = palette.alpha * (palette === PALETTE.light ? ALPHA_LIGHT : ALPHA_DARK);
        var edgeCol = palette.edge, edge = palette.strength;

        // Cells are discrete, so the field can only be shifted by whole rows --
        // blending two rows would smear them into grey.  On a grid this coarse
        // a row is tens of pixels, which made scrolling jump.  So the whole rows
        // are taken here and the remainder is handed to the compositor as a
        // transform on the canvas itself, which slides the drawn image without
        // resampling it.  The two compose into a continuous shift.
        var off = scrollNow * NY, o0 = Math.floor(off), frac = off - o0;
        var rowPx = Math.max(canvas.clientHeight, 1) / NY;
        // The canvas is inset past the viewport on every side; the shift has to
        // stay inside that overflow or it would drag an edge into view.  One row
        // fits comfortably at ordinary aspect ratios, but clamp rather than
        // trust it -- a very wide, short window makes rows tall.
        var slack = (canvas.clientHeight - window.innerHeight) / 2;
        var shift = frac * rowPx;
        if (shift > slack) shift = slack;
        canvas.style.transform = 'translateY(' + (-shift).toFixed(2) + 'px)';
        for (var y = 0; y < NY; y++) {
          var ya = (((y + o0) % NY) + NY) % NY, ra = ya * NX, out = y * NX * 4;
          var rn = YM[ya] * NX, rs = YP[ya] * NX;
          for (var x = 0; x < NX; x++) {
            var i = ra + x, v = lvl[i];

            // Light mode outlines a cluster rather than its individual cells:
            // a quiet square with lit neighbours is drawn faintly, so a group
            // gets a halo that thickens as it grows and thins as it breaks up.
            // Because it is driven by the neighbours' brightness, which moves
            // continuously, the halo fades rather than switching on.
            var halo = 0;
            if (edge > 0 && v < 0.5) {
              var nb = lvl[ra + XM[x]] + lvl[ra + XP[x]] +
                       lvl[rn + x] + lvl[rs + x] +
                       lvl[rn + XM[x]] + lvl[rn + XP[x]] +
                       lvl[rs + XM[x]] + lvl[rs + XP[x]];
              halo = nb * 0.28;
              if (halo > 1) halo = 1;
              halo *= (1 - 2 * v) * edge;
              if (halo < 0) halo = 0;
            }

            if (v <= 0.002 && halo <= 0.002) { px[out + 3] = 0; out += 4; continue; }

            // One colour ramp from live red through maroon to purple, indexed
            // by how dead the cell is.  Because that index moves continuously
            // in both directions, a reborn cell walks back toward red rather
            // than cutting to it.
            var k = dead[i], r, g, b;
            if (k < HOLD) {
              var t0 = k / HOLD;
              r = LIVE[0] + (DEAD_NEW[0] - LIVE[0]) * t0;
              g = LIVE[1] + (DEAD_NEW[1] - LIVE[1]) * t0;
              b = LIVE[2] + (DEAD_NEW[2] - LIVE[2]) * t0;
            } else {
              var t1 = (k - HOLD) / (1 - HOLD);
              r = DEAD_NEW[0] + (DEAD_OLD[0] - DEAD_NEW[0]) * t1;
              g = DEAD_NEW[1] + (DEAD_OLD[1] - DEAD_NEW[1]) * t1;
              b = DEAD_NEW[2] + (DEAD_OLD[2] - DEAD_NEW[2]) * t1;
            }
            var a = alpha * v;

            if (halo > 0) {
              r += (edgeCol[0] - r) * halo;
              g += (edgeCol[1] - g) * halo;
              b += (edgeCol[2] - b) * halo;
              var ah = halo * alpha;
              if (ah > a) a = ah;
            }
            a *= MASK[y * NX + x];
            px[out] = r; px[out + 1] = g; px[out + 2] = b; px[out + 3] = a * 255;
            out += 4;
          }
        }
        ctx.putImageData(img, 0, 0);
      }
    };
  })();

  var SIMS = { turbulence: TURB, shallow: SWE, convection: RBC, life: LIFE };
  var SIM_ORDER = ['turbulence', 'shallow', 'convection', 'life'];

  // ======================================================================
  // Rendering, theme, scroll and the frame loop
  // ======================================================================

  // pow(x, 1.35) for the alpha curve, tabulated -- it runs once per pixel
  var POW = new Float32Array(256);
  for (var pi = 0; pi < 256; pi++) POW[pi] = Math.pow(pi / 255, 1.35);

  var palette = PALETTE.dark;
  function readTheme() {
    palette = document.documentElement.dataset.theme === 'light' ? PALETTE.light : PALETTE.dark;
  }
  readTheme();
  new MutationObserver(readTheme).observe(document.documentElement,
    { attributes: true, attributeFilter: ['data-theme'] });

  var scrollTarget = 0, scrollNow = 0;
  function readScroll() { scrollTarget = window.scrollY * PARALLAX / Math.max(canvas.clientHeight, 1); }

  // Shared by the three continuous fields.  `mid` is the value that should read
  // as nothing at all -- zero for vorticity, the rest depth for shallow water,
  // the mean temperature for convection -- so the palette runs from one side of
  // it to the other.
  // `opts` describes the faint outlines light mode draws over the fill, which is
  // where most of the legibility comes from on a near-white page.  What reads as
  // the structure differs by phenomenon, so each simulation says what to trace:
  //   gradient  steep places in some field -- the rim of a vortex, the edge of a
  //             thermal plume -- which need not be the field being coloured
  //   contour   iso-lines of the field itself, which appear and disappear on
  //             their own as it rises and falls past each level
  function renderScalar(field, gain, mid, rowMid, opts) {
    var pos = palette.pos, neg = palette.neg, edgeCol = palette.edge;
    var alpha = palette.alpha, edge = palette.strength;
    var esrc = (opts && opts.src) || field;
    var contour = !!(opts && opts.mode === 'contour');
    var egain = (opts && opts.gain) || EDGE_GAIN * gain;
    var elevels = (opts && opts.levels) || 20;

    // Parallax is a vertical offset into a periodic domain, so it wraps
    // seamlessly with no taller canvas and no gap at the edge.  The sign sends
    // the field the opposite way to the page: scrolling down carries the
    // content up and the backdrop down.  A domain with walls cannot be shifted
    // this way without sliding the floor into view, so it opts out.
    var off = sim.parallax ? scrollNow * NY : 0;
    var o0 = Math.floor(off), ty = off - o0;

    for (var y = 0; y < NY; y++) {
      var ya = (((y + o0) % NY) + NY) % NY, yb = (ya + 1) % NY;
      var ra = ya * NX, rb = yb * NX, out = y * NX * 4;
      for (var x = 0; x < NX; x++) {
        var ma = rowMid ? rowMid[ya] : mid, mb = rowMid ? rowMid[yb] : mid;
        var v = ((field[ra + x] - ma) * (1 - ty) + (field[rb + x] - mb) * ty) * gain;

        var av = v < 0 ? -v : v;
        if (av > 1) av = 1;
        var a = POW[(av * 255) | 0] * alpha;

        var t = v < -0.05 ? 0 : (v > 0.05 ? 1 : (v + 0.05) * 10);
        var r = neg[0] + (pos[0] - neg[0]) * t;
        var g = neg[1] + (pos[1] - neg[1]) * t;
        var b = neg[2] + (pos[2] - neg[2]) * t;

        if (edge > 0) {
          var e;
          if (contour) {
            var cv = (esrc[ra + x] - ma) * elevels;
            var fr = cv - Math.floor(cv);
            var dd = fr < 0.5 ? fr : 1 - fr;          // 0 exactly on a contour
            e = dd >= CONTOUR_WIDTH ? 0 : 1 - dd / CONTOUR_WIDTH;
          } else {
            var gx = esrc[ra + XP[x]] - esrc[ra + XM[x]];
            var gy = esrc[rb + x] - esrc[ra + x];
            var mag = Math.sqrt(gx * gx + gy * gy) * egain;
            e = mag <= 0.40 ? 0 : (mag >= 1.05 ? 1 : (mag - 0.40) / 0.65);
          }
          e = e * e * (3 - 2 * e) * edge;
          r += (edgeCol[0] - r) * e; g += (edgeCol[1] - g) * e; b += (edgeCol[2] - b) * e;
          var ae = e * alpha;
          if (ae > a) a = ae;
        }

        a *= MASK[y * NX + x];
        px[out] = r; px[out + 1] = g; px[out + 2] = b; px[out + 3] = a * 255;
        out += 4;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // ---- choosing a simulation --------------------------------------------
  function pickSim() {
    var want = null;
    try { want = localStorage.getItem('sim'); } catch (e) {}
    // No pinned choice: carry on with whatever this browsing session was already
    // showing, so following a link to another page does not swap the backdrop.
    // A new tab or a fresh visit has no session value and so draws a new one.
    if (!want) { try { want = sessionStorage.getItem('sim-current'); } catch (e) {} }
    if (location.hash) {
      for (var i = 0; i < SIM_ORDER.length; i++)
        if (location.hash.indexOf(SIM_ORDER[i]) >= 0) want = SIM_ORDER[i];
    }
    if (want && SIMS[want]) return want;
    // Avoid re-picking whatever is already on screen: choosing "Random" and
    // getting the same one back looks like the control did nothing.
    var pool = SIM_ORDER;
    var current = document.documentElement.dataset.sim;
    if (current && SIMS[current]) {
      pool = SIM_ORDER.filter(function (n) { return n !== current; });
    }
    return pool[(Math.random() * pool.length) | 0];
  }

  var FADE_MS = 1000, pendingWarm = 0;   // each way: a change is a 2s dip

  // A new simulation needs history before it is worth looking at -- convection
  // has to run until the first rolls form or the page opens on a motionless
  // layer -- and that is hundreds of steps.  Doing them in one go would block
  // the page for most of a second and stall the very fade meant to cover it, so
  // they are spread over frames under a time budget while the canvas is still
  // invisible.  The reveal waits for the last of them, which means a slow
  // simulation simply stays faded out for longer rather than appearing half
  // formed.
  // ---- fading ------------------------------------------------------------
  //
  // The fade is driven here rather than by a CSS transition, for two reasons.
  // A CSS transition is at the mercy of the stylesheet: this page reduces every
  // transition to 0.01ms under prefers-reduced-motion, which silently turned
  // the cross-fade into an instant cut for anyone with that setting -- the fade
  // simply never ran for them.  And it has to work while the simulation is
  // stopped, so it cannot live inside the simulation's frame loop, which exits
  // when there is nothing to step.  It gets its own loop, above all of that.
  //
  // Changing simulation while it is running is a dip: fade out, swap while
  // nothing is visible, fade back in.  Pausing is only the first half of that --
  // it fades out and stays out -- and playing is only the second.
  var fadeNow = 0, fadeTarget = 0, fadeRaf = 0, fadeLast = 0, fadeArrive = null;
  var dipping = false, queuedChange = null;

  function ease(t) { return t * t * (3 - 2 * t); }

  function fadeFrame(stamp) {
    fadeRaf = 0;
    var dt = fadeLast ? Math.min((stamp - fadeLast) / 1000, 0.1) : 0;
    fadeLast = stamp;

    var stepAmt = dt / (FADE_MS / 1000);
    if (fadeNow < fadeTarget) fadeNow = Math.min(fadeTarget, fadeNow + stepAmt);
    else if (fadeNow > fadeTarget) fadeNow = Math.max(fadeTarget, fadeNow - stepAmt);

    canvas.style.opacity = ease(fadeNow).toFixed(3);

    if (fadeNow !== fadeTarget) {
      fadeRaf = requestAnimationFrame(fadeFrame);
    } else if (fadeArrive) {
      var f = fadeArrive; fadeArrive = null; f();
    }
  }

  function fadeTo(target, onArrive) {
    fadeTarget = target;
    fadeArrive = onArrive || null;
    if (fadeNow === fadeTarget) { if (fadeArrive) { var f = fadeArrive; fadeArrive = null; f(); } return; }
    if (!fadeRaf) { fadeLast = 0; fadeRaf = requestAnimationFrame(fadeFrame); }
  }

  // Reveal only when there is something to show and a reason to show it: the
  // field has finished warming up, and the simulation is not paused.  Paused
  // means hidden, so changing simulation while paused loads the new one out of
  // sight and it stays that way until play is pressed.
  function revealWhenReady() {
    if (pendingWarm > 0 || !wantRun) return;
    fadeTo(1);
  }

  function transition(apply) {
    if (dipping) { queuedChange = apply; return; }   // fold a second change in
    dipping = true;
    fadeTo(0, function () {
      apply();
      var next = queuedChange; queuedChange = null;
      if (next) next();
      dipping = false;
      revealWhenReady();
      kick();
    });
  }

  function beginSim(name) {
    sim = SIMS[name];
    wallY = sim.wallY;
    allocate();
    document.documentElement.dataset.sim = name;
    acc = 0; last = 0; renderAcc = 0;
    pendingWarm = sim.warmup || 20;
    canvas.style.transform = '';       // only the discrete grid needs one
    // Remember it for the rest of the browsing session, so moving between pages
    // carries on with the same simulation instead of drawing a new one.
    try { sessionStorage.setItem('sim-current', name); } catch (e) {}
    kick();
  }

  function warmSlice() {
    var t0 = now();
    while (pendingWarm > 0 && now() - t0 < WARM_BUDGET_MS) { sim.step(); pendingWarm--; }
    if (pendingWarm <= 0) {
      pendingWarm = 0;
      sim.render();
      revealWhenReady();              // only now, with a developed field to show
    }
  }

  // Switching swaps out a whole field, which is jarring done instantly.  The
  // canvas fades out over a full second, the replacement is built and warmed up
  // while nothing is visible, and only then does it fade back in -- so the
  // shortest a switch can take is the two seconds of the two fades, and longer
  // if the new simulation needs it.
  function setSim(name) {
    if (!SIMS[name]) name = SIM_ORDER[0];
    if (!sim) { beginSim(name); return; }        // first load: nothing to fade from
    if (name === document.documentElement.dataset.sim) return;
    transition(function () { beginSim(name); });
  }

  // A null detail means "surprise me": the stored choice has just been cleared,
  // so pickSim falls through to a random one.
  window.addEventListener('background:sim', function (e) {
    setSim((e && e.detail) || pickSim());
  });

  // ---- debug readout -----------------------------------------------------
  var dbg = null;
  if (location.hash.indexOf('debug') >= 0) {
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99;font:11px ui-monospace,monospace;' +
      'background:rgba(0,0,0,.72);color:#9f9;padding:6px 9px;border-radius:6px;white-space:pre;pointer-events:none';
    document.body.appendChild(box);
    dbg = function (t) { box.textContent = t; };
  }

  // ---- loop --------------------------------------------------------------
  // `wantRun` is what the toolbar button says; `running` is whether the loop is
  // still stepping.  They differ only while a pause is fading out: the field
  // keeps moving underneath until it is invisible, so the fade is of a live
  // picture rather than a frozen one.  Starting is immediate -- the simulation
  // resumes the instant the button is pressed and the fade catches up.
  var wantRun = false, running = false, ticking = false;
  var frames = 0, acc = 0, last = 0, renderAcc = 0;

  function easing() { return Math.abs(scrollTarget - scrollNow) > 0.00002; }

  function tick(stamp) {
    if (!running && !easing() && pendingWarm <= 0) { ticking = false; return; }
    requestAnimationFrame(tick);
    frames++;

    var dt = last ? Math.min((stamp - last) / 1000, 0.1) : 0;
    last = stamp;

    // Nothing else happens until the new field has been brought up to speed.
    if (pendingWarm > 0) { warmSlice(); return; }

    if (canvas.clientWidth &&
        Math.abs(canvas.clientWidth / canvas.clientHeight - ASPECT) > 0.25) {
      allocate();
      pendingWarm = sim.warmup || 20;
      return;
    }

    var before = scrollNow;
    scrollNow += (scrollTarget - scrollNow) * PARALLAX_EASE;
    var moved = Math.abs(scrollNow - before) > 1e-6;

    // Belt and braces: whatever else happened to the fade callbacks, a paused
    // and invisible field does not need stepping.
    if (!wantRun && fadeNow <= 0) running = false;

    var stepped = false, framed = false;
    if (running) {
      acc += dt;
      var budget = 3;                  // never chase more than a few steps at once
      var period = 1 / sim.stepHz;
      while (acc >= period && budget-- > 0) {
        acc -= period;
        stirAmp *= STIR_DECAY;
        if (stirAmp < 0.002) { stirAmp = 0; stirVel[0] = 0; stirVel[1] = 0; }
        sim.step();
        stepped = true;
      }
      if (acc > 0.5) acc = 0;
      // Some simulations do sub-step work: Life eases new cells in and releases
      // spawns between generations, so it changes on frames where it has not
      // stepped and has to be redrawn on those too.
      if (sim.frame) framed = sim.frame(dt) !== false;
    }
    // Otherwise there is nothing new to draw on a still page between steps.
    // A simulation may also ask to be drawn at a fixed rate below the display's
    // -- Life reads better at a steady twenty frames a second than at whatever
    // the monitor happens to run at.
    var due = stepped || framed;
    if (due && sim.renderHz) {
      renderAcc += dt;
      if (renderAcc < 1 / sim.renderHz) due = false; else renderAcc = 0;
    }
    // The parallax is the one thing that must keep up with the display rather
    // than with the simulation.  Life asks to be drawn at twenty frames a
    // second, and running its scroll offset at that rate too is what was left
    // of the judder -- the shift was smooth in value but only applied every
    // third frame.  A scroll therefore forces a draw regardless of the throttle.
    if (moved) due = true;
    if (due) sim.render();

    if (dbg && (frames % 20) === 0) {
      dbg('sim ' + sim.label + '   grid ' + NX + 'x' + NY +
          '   ' + sim.stepHz + ' steps/s   frames ' + frames +
          '   anim ' + document.documentElement.dataset.anim +
          (sim.stats ? '\n' + sim.stats() : ''));
    }
  }

  function kick() { if (!ticking) { ticking = true; requestAnimationFrame(tick); } }

  function setRunning(on) {
    if (on === wantRun) return;
    wantRun = on;
    if (on) {
      // Stepping resumes the instant the button is pressed; the fade catches up.
      running = true; last = 0; kick();
      revealWhenReady();
    } else {
      // Keep stepping through the fade-out, so what fades away is a live
      // picture, and stop once nothing is visible.  The field itself is never
      // reset, so playing again carries on from exactly where it stopped.
      fadeTo(0, function () { running = false; });
    }
  }

  function refresh() { setRunning(animOn() && !document.hidden); }

  window.addEventListener('scroll', function () { readScroll(); kick(); }, { passive: true });
  window.addEventListener('resize', function () { readScroll(); kick(); }, { passive: true });
  document.addEventListener('visibilitychange', refresh);
  new MutationObserver(refresh).observe(document.documentElement,
    { attributes: true, attributeFilter: ['data-anim'] });

  setSim(pickSim());
  readScroll();
  refresh();
})();
