# lupin.github.io

Personal site for Lenny Lupin-Jimenez — research and publications.

Live at https://lupify.github.io/lupin.github.io/

Four static pages, no build step:

- `index.html` — intro, contacts, and recent research in brief.
- `research.html` — earlier research positions, with publications.
- `projects.html` — things built outside of research.
- `resume.html` — the CV, embedded and downloadable.
- `styles.css`, `site.js` — shared by all of them.

`site.js` swaps `<main>` between pages rather than loading a new document, so
the background simulation carries on across a navigation instead of restarting.
That needs the site served over http — open it with `python3 -m http.server`
rather than by opening the files directly, or a `file://` origin blocks the
fetch and every link falls back to a full page load. The console says so when
that happens.

Light/dark theme follows the visitor's system preference and falls back to dark.

## Background simulations

`background.js` runs one of four simulations in plain JavaScript -- no WebGL,
no shaders, nothing to fall back from. One is chosen at random per page load,
and the picker in the toolbar switches between them; the choice persists, and
"Random" clears it. All four are masked to fade from the top-right corner to
nothing at the bottom left, and drift against the page as you scroll.

| | what it is | grid | steps/s | cost |
|---|---|---|---|---|
| Turbulence | forced 2D Navier-Stokes in vorticity-streamfunction form | 352x200 | 20 | 2.8 ms |
| Shallow water | the shallow water equations on a torus, lightly forced | 288x160 | 30 | 0.9 ms |
| Convection | Rayleigh-Benard between a hot floor and a cold ceiling | 288x160 | 24 | 2.2 ms |
| Conway's Life | Life, with cells fading through maroon to purple as they die | 120x64 | 6 | negligible |

The two that carry a streamfunction share one multigrid Poisson solver, which
is why they read as flows rather than as noise: Gauss-Seidel on a single grid
clears high-frequency error quickly but barely touches the smooth, large-scale
part, and the large scales are what the eye sees. Measured, 28 single-grid
sweeps left the residual at 114% of where it started; one V-cycle cuts it to
6.6%. The solver is periodic in both directions for turbulence and has solid
walls in y for convection, which is what makes the plates real boundaries
rather than a wrap-around.

Two habits run through all of them. Amplitude is held by a controller that
nudges the field toward a target rms rather than by balancing forcing against
damping -- that balance equilibrates far too slowly and noisily to tune, and
the shallow water layer climbed for as long as it was measured without one.
And opacity is set against a contrast budget, allowing for the CSS glow peaking
in the same corner. Light mode is the tight case: contrast there is paid for in
luminance, not saturation, so the tints are light but strongly saturated.

Press `m` to cycle what is drawn; `#debug` shows a live readout, and
`#convection`, `#shallow`, `#life` or `#turbulence` force one. The toolbar
button controls whether anything animates, defaulting to off when the system
asks for reduced motion.
