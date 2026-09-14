/*
 * Ambient 2D turbulence, on the CPU.
 *
 * A random low-wavenumber vorticity field is left to run down under 2D
 * incompressible flow with small band-limited forcing, and a passive tracer
 * riding that flow is what actually gets drawn.
 *
 * Solved in vorticity-streamfunction form:
 *
 *     laplacian(psi) = -omega,   u = d(psi)/dy,  v = -d(psi)/dx
 *
 * Carrying psi rather than a velocity pair means the Poisson solve *is* the
 * incompressibility projection: no separate pressure step, one scalar advected.
 *
 * The Poisson solve is a multigrid V-cycle. That is the whole reason this looks
 * like a flow at all. Jacobi or Gauss-Seidel on their own wipe out
 * high-frequency error quickly but need O(N^2) sweeps to touch the smooth,
 * large-scale part -- and the large scales are exactly what reads as eddies. A
 * V-cycle carries the error down to a 24x13 grid where "smooth" is cheap to
 * solve, so every scale converges at the same rate and one cycle per step is
 * enough.
 *
 * Everything is sized so the per-frame cost is a few hundred thousand
 * operations on a 192x104 grid: no WebGL, no shaders, nothing to fall back from.
 */
(function () {
  'use strict';

  var canvas = document.getElementById('field');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) { console.warn('[background] disabled: no 2d context'); return; }

  // ---- tunables ----------------------------------------------------------
  // Grid width. Cost is roughly linear in cell count: 128 -> 0.6 ms/frame,
  // 160 -> 1.2, 192 -> 1.7 (measured headless on V8). 160 keeps a mid-range
  // laptop near 7% of one core while still resolving filaments; narrow screens
  // drop further since the canvas is stretched to fit either way.
  var NX = window.innerWidth < 760 ? 176 : 352;             // sim grid width; height follows the viewport aspect
  // Stepping less often and taking a bigger step costs proportionally less CPU
  // for the same motion, because every per-step rate below is written as a
  // multiple of DT -- halve the rate, double DT, and the per-second behaviour is
  // unchanged. That is what buys the higher grid resolution.
  var STEP_HZ = 20;         // simulation steps per second
  var DT = 0.204;           // timestep; every per-step rate below scales with it

  var ADVECT    = 2.6 * DT;
  var DISSIPATE = 1 - 0.0010 * DT;  // stronger than before: heavier drag on the
                                    // large scales is what stops the inverse cascade
                                    // parking everything in one persistent vortex

  var SEED_AMP = 0.30, SEED_KLO = 1.0, SEED_KHI = 3.0,  SEED_N  = 32;
  // Forcing is a band of Fourier modes whose complex amplitudes each follow an
  // Ornstein-Uhlenbeck process -- a random walk with a pull back toward zero.
  // That is smooth in space (it is a band-limited mode sum, so nothing appears
  // abruptly anywhere) but genuinely aperiodic in time, unlike phases that drift
  // at fixed rates and keep re-aligning. Quiet modes are also moved to fresh
  // wavevectors now and then, so the forced scales drift as well.
  var FORCE_N    = 10;
  var FORCE_KLO  = 5.0, FORCE_KHI = 11.0;
  var FORCE_AMP  = 0.030 * DT;   // per-step injection
  var FORCE_TAU  = 150;          // amplitude correlation time, in steps
  var FORCE_EVERY = 2;           // rebuild the field this often; it drifts slowly

  // Forcing and damping set the character of the flow -- how much new structure
  // appears and how fast old structure fades -- but between them they are a poor
  // way to pin the overall level. Stochastic forcing plus an inverse cascade
  // equilibrates over several minutes and with enough variance that two runs of
  // the same settings land far apart; measured, halving the forcing barely moved
  // where it ended up. So the level is held directly instead, by nudging the
  // whole field toward a target rms a fraction of a percent per step. Uniform
  // scaling changes no structure, only amplitude, and it makes the visible
  // result independent of how the forcing and damping happen to balance.
  var TARGET_OM = 0.22, TARGET_DY = 0.50;
  var LEVEL_RATE = 0.02, LEVEL_CLAMP = 0.02;
  var RESAMPLE_P = 0.02;         // chance per mode per step of moving a quiet one

  // The tracer is fed the same way, at larger scales so the flow has something
  // to stretch into filaments.
  var DYE_N     = 8;
  var DYE_KLO   = 2.0, DYE_KHI = 5.0;
  var DYE_AMP   = 0.13 * DT;
  var DYE_DECAY = 1 - 0.0016 * DT;
  var DYE_SLACK = 0;            // strict limiter; see the note in advect()
  var DYE_GAIN  = 1.7;
  var GAIN = 1.6;

  var PARALLAX = 0.12, PARALLAX_EASE = 0.075;
  var STIR_RADIUS = 0.075, STIR_AMP = 0.55, STIR_DECAY = 0.86;

  // Blur, in units of one simulation cell as it appears on screen. The grid is
  // stretched to the viewport, so a blur of about one cell hides the cell
  // structure completely -- far cheaper than the resolution it would take to
  // make individual cells small enough not to see. It is a compositor filter,
  // so it costs the page essentially nothing.
  var BLUR_CELLS = 1.15;

  var EDGE_LIGHT = 0.45, EDGE_DARK = 0.0, EDGE_GAIN = 9.0;

  // The field is strongest at the top right and fades to nothing toward the
  // left and the bottom, measured as distance from that corner along the
  // diagonal: 0 at the corner, 1 at the bottom left.
  var MASK_NEAR = 0.06;   // at or inside this, full strength
  var MASK_FAR  = 0.92;   // at or beyond this, nothing at all

  var VCYCLES = 1, PRE = 2, POST = 2, COARSE_ITERS = 24;

  // Opacity is set against the contrast budget, not by eye, and it has to allow
  // for the fact that the purple lobe of the page's CSS glow peaks in the same
  // top-right corner -- the two stack there. Dark is the easy case: the dye is
  // darker than the glow-lit background, so it darkens and light text actually
  // gains. Light is the tight one, and the edge lines are what cost there, so
  // they are drawn in a much lighter grey than before.
  var PALETTE = {
    dark:  { pos: [58, 26, 36],   neg: [8, 7, 11],      alpha: 0.26,
             edge: [0, 0, 0],        strength: EDGE_DARK },
    // The light fills were near-white and carried almost no colour. Contrast
    // here is paid for in luminance, not in saturation, so swapping them for
    // equally light but strongly saturated tints buys about twelve times the
    // colour separation between a positive and a negative cell at exactly the
    // same opacity and the same 5.35:1 on muted text.
    light: { pos: [255, 147, 181], neg: [167, 148, 247], alpha: 0.16,
             edge: [185, 170, 179],  strength: EDGE_LIGHT }
  };

  // 'dye' | 'vorticity' | 'both'
  var RENDER = 'dye';
  ['dye', 'vorticity', 'both'].forEach(function (m) {
    if (location.hash.indexOf(m) >= 0) RENDER = m;
  });
  window.addEventListener('keydown', function (e) {
    if (e.key !== 'm' || e.metaKey || e.ctrlKey || e.altKey) return;
    var order = ['dye', 'vorticity', 'both'];
    RENDER = order[(order.indexOf(RENDER) + 1) % order.length];
  });

  var dbg = null;
  if (location.hash.indexOf('debug') >= 0) {
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99;font:11px ui-monospace,monospace;' +
      'background:rgba(0,0,0,.72);color:#9f9;padding:6px 9px;border-radius:6px;white-space:pre;pointer-events:none';
    document.body.appendChild(box);
    dbg = function (t) { box.textContent = t; };
  }

  function animOn() { return document.documentElement.dataset.anim !== 'off'; }

  // ---- grids -------------------------------------------------------------
  // Both dimensions must stay divisible by 8 so the V-cycle has three levels
  // to coarsen through.
  var NY, N, ASPECT;
  var om, dy, psi, fwdA, fwdB, forceF, dyeF, seedOm;
  var levels = [];

  function roundTo8(v) { return Math.max(32, Math.round(v / 8) * 8); }

  // Neighbour index tables. The inner loops are dominated by wrap-around
  // arithmetic, and a table lookup is markedly cheaper than two modulos per
  // access on every cell, every sweep.
  var XM, XP, YM, YP, MASK;

  // Distance from the top-right corner, smoothstepped. Row 0 of the image is
  // the top of the canvas, so the corner is (x = NX-1, y = 0). Precomputed
  // because it never changes between resizes and would otherwise be a square
  // root per pixel per frame.
  function buildMask() {
    MASK = new Float32Array(NX * NY);
    var inv = 1 / Math.SQRT2;
    for (var y = 0; y < NY; y++) {
      var dv = y / Math.max(NY - 1, 1);              // 0 at the top
      for (var x = 0; x < NX; x++) {
        var du = 1 - x / Math.max(NX - 1, 1);        // 0 at the right
        var d = Math.sqrt(du * du + dv * dv) * inv;
        var t = (d - MASK_NEAR) / (MASK_FAR - MASK_NEAR);
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        MASK[y * NX + x] = 1 - t * t * (3 - 2 * t);
      }
    }
  }
  function buildWrap() {
    XM = new Int32Array(NX); XP = new Int32Array(NX);
    YM = new Int32Array(NY); YP = new Int32Array(NY);
    for (var x = 0; x < NX; x++) { XM[x] = (x - 1 + NX) % NX; XP[x] = (x + 1) % NX; }
    for (var y = 0; y < NY; y++) { YM[y] = (y - 1 + NY) % NY; YP[y] = (y + 1) % NY; }
  }

  function allocate() {
    var aspect = Math.max(canvas.clientWidth, 1) / Math.max(canvas.clientHeight, 1);
    NY = Math.min(roundTo8(NX / aspect), NX);
    N = NX * NY;
    ASPECT = NX / NY;

    om = new Float32Array(N); dy = new Float32Array(N); psi = new Float32Array(N);
    fwdA = new Float32Array(N); fwdB = new Float32Array(N);
    forceF = new Float32Array(N); dyeF = new Float32Array(N); seedOm = new Float32Array(N);

    levels = [];
    var w = NX, h = NY, hh = 1;
    for (var l = 0; l < 4; l++) {
      levels.push({ w: w, h: h, h2: hh * hh,
                    u: new Float32Array(w * h), f: new Float32Array(w * h),
                    r: new Float32Array(w * h) });
      if (w % 2 || h % 2) break;
      w >>= 1; h >>= 1; hh *= 2;
    }

    fwdBuf1 = new Float32Array(N); fwdBuf2 = new Float32Array(N);

    buildWrap();
    buildMask();
    // One simulation cell, measured in CSS pixels on screen.
    var cellPx = Math.max(canvas.clientWidth, 1) / NX;
    canvas.style.filter = 'blur(' + (BLUR_CELLS * cellPx).toFixed(2) + 'px)';
    canvas.width = NX; canvas.height = NY;
    img = ctx.createImageData(NX, NY);
    px = img.data;
    for (var i = 3; i < px.length; i += 4) px[i] = 255;
  }

  var img = null, px = null, fwdBuf1 = null, fwdBuf2 = null;

  // ---- random Fourier modes ---------------------------------------------
  // cos(a+b) and sin(a+b) expand into products of per-axis terms, so a mode sum
  // costs two multiplies per cell with no transcendentals in the inner loop.
  // Folding the amplitudes into per-column P and Q first is what keeps a
  // stochastic, every-frame forcing affordable on the CPU.
  function gauss() {
    return (Math.random() + Math.random() + Math.random() - 1.5) * 1.4142;
  }

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

  // One OU step per mode. Stationary variance is held at 1 so the field's scale
  // is set by the caller's amplitude alone.
  function driftModes(modes) {
    var theta = 1 / FORCE_TAU, sigma = Math.sqrt(2 * theta);
    for (var m = 0; m < modes.length; m++) {
      var M = modes[m];
      M.ar += -theta * M.ar + sigma * gauss();
      M.ai += -theta * M.ai + sigma * gauss();
      // Only move a mode while it is quiet, so its spatial pattern never jumps.
      if (Math.random() < RESAMPLE_P && M.ar * M.ar + M.ai * M.ai < 0.02) {
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

  // ---- multigrid ---------------------------------------------------------
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
          var yn = (y === 0 ? h - 1 : y - 1) * w, yp = (y + 1 === h ? 0 : y + 1) * w, row = y * w;
          for (var x = (y + color) & 1; x < w; x += 2) {
            var xn = x === 0 ? w - 1 : x - 1, xp = x + 1 === w ? 0 : x + 1;
            u[row + x] = 0.25 * (u[row + xn] + u[row + xp] + u[yn + x] + u[yp + x] - h2 * f[row + x]);
          }
        }
      }
    }
  }

  function residual(L) {
    var w = L.w, h = L.h, u = L.u, f = L.f, r = L.r, inv = 1 / L.h2;
    for (var y = 0; y < h; y++) {
      var yn = (y === 0 ? h - 1 : y - 1) * w, yp = (y + 1 === h ? 0 : y + 1) * w, row = y * w;
      for (var x = 0; x < w; x++) {
        var xn = x === 0 ? w - 1 : x - 1, xp = x + 1 === w ? 0 : x + 1;
        r[row + x] = f[row + x] -
          (u[row + xn] + u[row + xp] + u[yn + x] + u[yp + x] - 4 * u[row + x]) * inv;
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
    removeMean(dst);   // the periodic operator is singular; keep the rhs compatible
  }

  function prolongAdd(coarse, fine) {
    var cw = coarse.w, ch = coarse.h, fw = fine.w, fh = fine.h, src = coarse.u, dst = fine.u;
    for (var y = 0; y < fh; y++) {
      var gy = (y - 0.5) * 0.5, y0 = Math.floor(gy), ty = gy - y0;
      var ya = ((y0 % ch) + ch) % ch, yb = (ya + 1) % ch;
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
    if (l === levels.length - 1) { smooth(L, COARSE_ITERS); removeMean(L.u); return; }
    smooth(L, PRE);
    residual(L);
    restrict(L, levels[l + 1]);
    vcycle(l + 1);
    prolongAdd(levels[l + 1], L);
    smooth(L, POST);
  }

  function solvePsi() {
    var L = levels[0], i;
    for (i = 0; i < N; i++) L.f[i] = -om[i];
    removeMean(L.f);
    L.u.set(psi);                       // warm start from the previous step
    for (i = 0; i < VCYCLES; i++) vcycle(0);
    removeMean(L.u);
    psi.set(L.u);
  }

  // ---- advection ---------------------------------------------------------
  function sample(f, x, y) {
    var x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
    var xa = x0, ya = y0;
    while (xa < 0) xa += NX;  while (xa >= NX) xa -= NX;
    while (ya < 0) ya += NY;  while (ya >= NY) ya -= NY;
    var xb = xa + 1 === NX ? 0 : xa + 1, yb = ya + 1 === NY ? 0 : ya + 1;
    var ra = ya * NX, rb = yb * NX;
    return (f[ra + xa] * (1 - tx) + f[ra + xb] * tx) * (1 - ty) +
           (f[rb + xa] * (1 - tx) + f[rb + xb] * tx) * ty;
  }

  var velX = null, velY = null;

  function velocity() {
    if (!velX || velX.length !== N) { velX = new Float32Array(N); velY = new Float32Array(N); }
    for (var y = 0; y < NY; y++) {
      var yn = YM[y] * NX, yp = YP[y] * NX, row = y * NX;
      for (var x = 0; x < NX; x++) {
        velX[row + x] = 0.5 * (psi[yp + x] - psi[yn + x]);       //  u =  d(psi)/dy
        velY[row + x] = -0.5 * (psi[row + XP[x]] - psi[row + XM[x]]); //  v = -d(psi)/dx
      }
    }
  }

  // MacCormack: advect forward, advect that back, and correct by half the
  // round-trip error. Plain semi-Lagrangian is strongly low-pass and would
  // smooth the field flat within seconds.
  // `slack` relaxes the monotonicity limiter. 0 is the strict form: every updated
  // cell is pinned inside its neighbours' range. That is required for vorticity,
  // because the MacCormack correction is anti-diffusive and will otherwise grow
  // without bound -- but it is also what flattens the thin filaments the tracer
  // is drawn from. Removing the limiter entirely is not the answer either: the
  // tracer then grows until it saturates its safety rail and stops responding to
  // the forcing at all. Allowing a bounded overshoot keeps the filaments sharp
  // while still capping the growth.
  function advect(src, dst, slack) {
    var x, y, i;
    for (y = 0; y < NY; y++)
      for (x = 0; x < NX; x++) {
        i = y * NX + x;
        fwdA[i] = sample(src, x - ADVECT * velX[i], y - ADVECT * velY[i]);
      }
    for (y = 0; y < NY; y++)
      for (x = 0; x < NX; x++) {
        i = y * NX + x;
        fwdB[i] = sample(fwdA, x + ADVECT * velX[i], y + ADVECT * velY[i]);
      }
    for (y = 0; y < NY; y++) {
      var yn = YM[y] * NX, yp = YP[y] * NX, row = y * NX;
      for (x = 0; x < NX; x++) {
        i = row + x;
        var c = fwdA[i] + 0.5 * (src[i] - fwdB[i]);
        var a = src[i], b = src[row + XM[x]], cc = src[row + XP[x]], d = src[yn + x], e = src[yp + x];
        var lo = a < b ? a : b; if (cc < lo) lo = cc; if (d < lo) lo = d; if (e < lo) lo = e;
        var hi = a > b ? a : b; if (cc > hi) hi = cc; if (d > hi) hi = d; if (e > hi) hi = e;
        // A slack proportional to the local range compounds: each step permits a
        // fresh overshoot of an already-widened range, which grows geometrically
        // and blew up to NaN within a minute. Any relaxation has to be bounded in
        // absolute terms, not relative to a quantity the relaxation itself grows.
        if (slack > 0) { lo -= slack; hi += slack; }
        dst[i] = c < lo ? lo : (c > hi ? hi : c);
      }
    }
  }

  // ---- pointer stirring --------------------------------------------------
  var stirPos = [0.5, 0.5], stirVel = [0, 0], stirAmp = 0, lastPtr = null;

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
  // the signature of something dragged through a fluid rather than paint dropped
  // in. Only cells inside the blob are touched.
  function applyStir() {
    if (stirAmp < 0.002) return;
    var cx = stirPos[0] * NX, cy = (stirPos[1] - Math.floor(stirPos[1])) * NY;
    var rx = STIR_RADIUS * NX, ry = STIR_RADIUS * NY;
    var x0 = Math.floor(cx - 2 * rx), x1 = Math.ceil(cx + 2 * rx);
    var y0 = Math.floor(cy - 2 * ry), y1 = Math.ceil(cy + 2 * ry);
    var amp = stirAmp * STIR_AMP, vx = stirVel[0] * NX, vy = stirVel[1] * NY;
    for (var y = y0; y <= y1; y++) {
      var yy = ((y % NY) + NY) % NY, row = yy * NX, dyc = (y - cy) / ry;
      for (var x = x0; x <= x1; x++) {
        var xx = ((x % NX) + NX) % NX, dxc = (x - cx) / rx;
        var g = Math.exp(-(dxc * dxc + dyc * dyc));
        om[row + xx] += amp * g * (vy * dxc - vx * dyc) * 0.02;
      }
    }
  }

  // Mexican-hat vortex: a core with a counter-rotating annulus. The profile
  // (1 - r^2/R^2)exp(-r^2/R^2) integrates to exactly zero over the plane, so
  // injecting one adds no net circulation -- which matters on a periodic domain,
  // where the Poisson problem is only solvable when mean vorticity is zero.
  // ---- one simulation step -----------------------------------------------
  var simTime = 0, seedModes = null, forceModes = null, dyeModes = null;

  function seedField() {
    seedModes  = makeModes(SEED_N,  SEED_KLO,  SEED_KHI,  true);
    forceModes = makeModes(FORCE_N, FORCE_KLO, FORCE_KHI, true);
    dyeModes   = makeModes(DYE_N,   DYE_KLO,   DYE_KHI,   true);
    evalModes(seedModes, seedOm, SEED_AMP);
    om.set(seedOm);
    evalModes(dyeModes, dy, 0.5);
    psi.fill(0);
    simTime = 0;
  }

  function level(rms, target) {
    if (!(rms > 1e-6)) return 1;
    var k = 1 + LEVEL_RATE * (target / rms - 1);
    return k < 1 - LEVEL_CLAMP ? 1 - LEVEL_CLAMP : (k > 1 + LEVEL_CLAMP ? 1 + LEVEL_CLAMP : k);
  }

  function step() {
    solvePsi();
    velocity();

    advect(om, fwdBuf1, 0);
    om.set(fwdBuf1);
    advect(dy, fwdBuf2, DYE_SLACK);
    dy.set(fwdBuf2);

    simTime++;
    driftModes(forceModes);
    driftModes(dyeModes);
    if (simTime % FORCE_EVERY === 0) {
      evalModes(forceModes, forceF, FORCE_AMP * FORCE_EVERY);
      evalModes(dyeModes, dyeF, DYE_AMP * FORCE_EVERY);
    }

    var so = 0, sd = 0, cnt = 0, i;
    for (i = 0; i < N; i += 8) { so += om[i] * om[i]; sd += dy[i] * dy[i]; cnt++; }
    var ko = level(Math.sqrt(so / cnt), TARGET_OM) * DISSIPATE;
    var kd = level(Math.sqrt(sd / cnt), TARGET_DY) * DYE_DECAY;

    if (simTime % FORCE_EVERY === 0) {
      for (i = 0; i < N; i++) {
        om[i] = om[i] * ko + forceF[i];
        dy[i] = dy[i] * kd + dyeF[i];
      }
    } else {
      for (i = 0; i < N; i++) { om[i] *= ko; dy[i] *= kd; }
    }
    applyStir();
  }

  // ---- rendering ---------------------------------------------------------
  var palette = PALETTE.dark;
  function readTheme() {
    palette = document.documentElement.dataset.theme === 'light' ? PALETTE.light : PALETTE.dark;
  }
  readTheme();
  new MutationObserver(readTheme).observe(document.documentElement,
    { attributes: true, attributeFilter: ['data-theme'] });

  var scrollTarget = 0, scrollNow = 0;
  function readScroll() { scrollTarget = window.scrollY * PARALLAX / Math.max(canvas.clientHeight, 1); }

  // pow(x, 1.35) for the alpha curve, tabulated -- it runs once per pixel
  var POW = new Float32Array(256);
  for (var pi = 0; pi < 256; pi++) POW[pi] = Math.pow(pi / 255, 1.35);

  function render() {
    var mode = RENDER === 'vorticity' ? 0 : (RENDER === 'both' ? 2 : 1);
    var pos = palette.pos, neg = palette.neg, edgeCol = palette.edge;
    var alpha = palette.alpha, edge = palette.strength;

    // Parallax is a vertical offset into a periodic domain, so it wraps
    // seamlessly with no taller canvas and no gap at the edge. The sign sends
    // the field the opposite way to the page: scrolling down carries the
    // content up and the backdrop down.
    var off = scrollNow * NY, o0 = Math.floor(off), ty = off - o0;

    for (var y = 0; y < NY; y++) {
      var ya = (((y + o0) % NY) + NY) % NY, yb = (ya + 1) % NY;
      var ra = ya * NX, rb = yb * NX, out = y * NX * 4;
      for (var x = 0; x < NX; x++) {
        var w = om[ra + x] * (1 - ty) + om[rb + x] * ty;
        var d = dy[ra + x] * (1 - ty) + dy[rb + x] * ty;
        var v = mode === 0 ? w * GAIN : (mode === 1 ? d * DYE_GAIN
                                                    : d * DYE_GAIN * 0.65 + w * GAIN * 0.35);

        var av = v < 0 ? -v : v;
        if (av > 1) av = 1;
        var a = POW[(av * 255) | 0] * alpha;

        var t = v < -0.05 ? 0 : (v > 0.05 ? 1 : (v + 0.05) * 10);
        var r = neg[0] + (pos[0] - neg[0]) * t;
        var g = neg[1] + (pos[1] - neg[1]) * t;
        var b = neg[2] + (pos[2] - neg[2]) * t;

        if (edge > 0) {
          var gx = om[ra + XP[x]] - om[ra + XM[x]];
          var gy = om[rb + x] - om[ra + x];
          var mag = Math.sqrt(gx * gx + gy * gy) * EDGE_GAIN;
          var e = mag <= 0.40 ? 0 : (mag >= 1.05 ? 1 : (mag - 0.40) / 0.65);
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

  // ---- loop --------------------------------------------------------------
  var running = false, ticking = false, frames = 0, acc = 0, last = 0;

  function easing() { return Math.abs(scrollTarget - scrollNow) > 0.00002; }

  function tick(now) {
    if (!running && !easing()) { ticking = false; return; }
    requestAnimationFrame(tick);
    frames++;

    var dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
    last = now;

    if (canvas.clientWidth && Math.abs(canvas.clientWidth / canvas.clientHeight - ASPECT) > 0.25) {
      allocate(); seedField();
    }

    var before = scrollNow;
    scrollNow += (scrollTarget - scrollNow) * PARALLAX_EASE;
    var moved = Math.abs(scrollNow - before) > 1e-6;

    var stepped = false;
    if (running) {
      acc += dt;
      var budget = 3;   // never try to catch up more than a few steps at once
      while (acc >= 1 / STEP_HZ && budget-- > 0) {
        acc -= 1 / STEP_HZ;
        stirAmp *= STIR_DECAY;
        if (stirAmp < 0.002) { stirAmp = 0; stirVel[0] = 0; stirVel[1] = 0; }
        step();
        stepped = true;
      }
      if (acc > 0.5) acc = 0;
    }
    // The simulation advances at 30Hz and the parallax only moves while
    // scrolling, so on a still page there is nothing new to draw on half the
    // frames. Skipping those halves the idle cost for no visible difference.
    if (stepped || moved) render();

    if (dbg && (frames % 20) === 0) {
      var sd = 0, so = 0, nn = 0;
      for (var i = 0; i < N; i += 7) { sd += dy[i] * dy[i]; so += om[i] * om[i]; nn++; }
      dbg('frames ' + frames + '  anim ' + document.documentElement.dataset.anim +
          '  grid ' + NX + 'x' + NY + '  levels ' + levels.length +
          '  render ' + RENDER + '  par ' + scrollNow.toFixed(3) +
          '  om_rms ' + Math.sqrt(so / nn).toFixed(4) +
          '  dye_rms ' + Math.sqrt(sd / nn).toFixed(4));
    }
  }

  function kick() { if (!ticking) { ticking = true; requestAnimationFrame(tick); } }
  function setRunning(on) { running = on; if (on) { last = 0; kick(); } }
  function refresh() { setRunning(animOn() && !document.hidden); }

  window.addEventListener('scroll', function () { readScroll(); kick(); }, { passive: true });
  window.addEventListener('resize', function () { readScroll(); kick(); }, { passive: true });
  document.addEventListener('visibilitychange', refresh);
  new MutationObserver(refresh).observe(document.documentElement,
    { attributes: true, attributeFilter: ['data-anim'] });

  allocate();
  seedField();
  readScroll();

  render();
  refresh();

  // A paused page still needs a developed field rather than the raw random
  // seed, but settling costs a few milliseconds per step and must not block
  // first paint -- so it happens after load, in slices, and only when the
  // simulation is not going to develop the field on its own anyway.
  if (!animOn()) {
    var settled = 0;
    (function settle() {
      if (animOn() || settled >= 60) { render(); return; }
      for (var k = 0; k < 6; k++) step();
      settled += 6;
      render();
      setTimeout(settle, 0);
    })();
  }
})();
