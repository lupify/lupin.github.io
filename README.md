# lupin.github.io

Personal site for Lenny Lupin-Jimenez — research and publications.

Live at https://lupify.github.io/lupin.github.io/

Three static pages, no build step:

- `index.html` — intro, contacts, and current work in brief.
- `research.html` — earlier research positions, with publications.
- `projects.html` — things built outside of research.
- `styles.css`, `site.js` — shared by all three.

Light/dark theme follows the visitor's system preference and falls back to dark.

## Background field

`background.js` runs a small 2D turbulence simulation in plain JavaScript --
no WebGL, no shaders, nothing to fall back from. A passive tracer carried by
the flow is what gets drawn. It is masked to fade from the top right corner to
nothing at the bottom left, and shifts against the page as you scroll.

The Poisson solve is a multigrid V-cycle, which is what makes it look like a
flow: plain Gauss-Seidel clears high-frequency error fast but barely touches
the smooth, large-scale part, and the large scales are what read as eddies.
Measured, 28 single-grid sweeps left the residual at 114% of its starting
value; one V-cycle cuts it to 6.6%.

Forcing is a band of Fourier modes whose complex amplitudes follow an
Ornstein-Uhlenbeck process, with quiet modes occasionally moved to new
wavevectors -- smooth in space, aperiodic in time. The overall level is held by
nudging the field toward a target rms each step rather than by balancing
forcing against damping, which equilibrates too slowly and too noisily to tune.

The canvas is drawn at grid resolution and CSS-blurred by about one cell, which
removes the upscaling artefacts far more cheaply than the resolution it would
take to make the cells invisible.

Opacity is set against a contrast budget rather than by eye, allowing for the
fact that the CSS glow peaks in the same corner and the two stack there. Light
mode is the tight case: contrast there is paid for in luminance, not
saturation, so the tints are light but strongly saturated -- which buys colour
almost for free.

Roughly 2.5 ms per frame at 352x200 (~15% of one core); `NX` is the knob, and
cost is close to linear in cell count. Press `m` to cycle what is drawn;
`#debug` shows a live readout. The toolbar button controls whether it animates,
defaulting to off when the system asks for reduced motion.
