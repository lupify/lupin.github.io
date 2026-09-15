// Shared behaviour for every page: theme toggle and scroll reveals.
// The pre-paint theme resolution lives inline in each page's <head>; it has to
// run before first paint, which a deferred script cannot do.
(function () {
  'use strict';

  var root = document.documentElement;

  var theme = document.getElementById('theme-toggle');
  if (theme) {
    theme.addEventListener('click', function () {
      var next = root.dataset.theme === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      try { localStorage.setItem('theme', next); } catch (e) {}
    });
  }

  // Follow the OS while the visitor hasn't picked a side themselves.
  try {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function (e) {
      if (!localStorage.getItem('theme')) root.dataset.theme = e.matches ? 'light' : 'dark';
    });
  } catch (e) {}

  // Background animation toggle. Only present when the simulation is enabled.
  var motion = document.getElementById('motion-toggle');
  if (motion) {
    var syncMotion = function () {
      var on = root.dataset.anim !== 'off';
      motion.setAttribute('aria-label', on ? 'Pause background animation' : 'Play background animation');
    };
    syncMotion();
    motion.addEventListener('click', function () {
      var next = root.dataset.anim === 'off' ? 'on' : 'off';
      root.dataset.anim = next;
      syncMotion();
      try { localStorage.setItem('anim', next); } catch (e) {}
    });
  }

  // Background simulation picker.  The menu shows whichever simulation is
  // actually running, so it reads correctly before it is opened and the native
  // control highlights that entry once it is.  "Random" is an action rather
  // than a state: it shuffles now and clears the stored choice so later loads
  // shuffle too, and the menu then shows whatever came up.
  var simSel = document.getElementById('sim-select');
  if (simSel) {
    var showRunning = function () {
      var running = root.dataset.sim;
      if (running && simSel.value !== running) {
        simSel.value = running;
        if (simSel.selectedIndex < 0) simSel.value = 'random';
      }
    };
    showRunning();
    // background.js writes data-sim once it has chosen and whenever it swaps.
    new MutationObserver(showRunning).observe(root,
      { attributes: true, attributeFilter: ['data-sim'] });

    simSel.addEventListener('change', function () {
      var v = simSel.value;
      try {
        if (v === 'random') {
          localStorage.removeItem('sim');
          // also drop the session's running choice, or "Random" would just be
          // handed back whatever is already on screen
          sessionStorage.removeItem('sim-current');
        } else localStorage.setItem('sim', v);
      } catch (e) {}
      window.dispatchEvent(new CustomEvent('background:sim',
        { detail: v === 'random' ? null : v }));
    });
  }

  // Hairline under the top bar once the page scrolls.
  var topbar = document.getElementById('topbar');
  if (topbar) {
    var onScroll = function () { topbar.dataset.stuck = window.scrollY > 8; };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  // Reveal on entry.  Re-runnable, because soft navigation swaps in new content.
  var io = null;
  function initReveals() {
    var items = document.querySelectorAll('.reveal:not(.is-in)');
    if (!('IntersectionObserver' in window)) {
      Array.prototype.forEach.call(items, function (el) { el.classList.add('is-in'); });
      return;
    }
    if (!io) {
      io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) { entry.target.classList.add('is-in'); io.unobserve(entry.target); }
        });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    }
    Array.prototype.forEach.call(items, function (el) { io.observe(el); });
  }
  initReveals();

  // Mark whichever page is showing.  aria-current is the attribute a screen
  // reader announces for this, and the stylesheet hangs off it, so one
  // assignment covers both.  It has to be re-applied after a soft navigation,
  // which swaps the whole nav out.
  function markCurrentPage() {
    // "/" and "/index.html" are the same page; normalise before comparing
    var here = location.pathname.replace(/\/(index\.html)?$/, '/');
    var links = document.querySelectorAll('nav.nav a');
    Array.prototype.forEach.call(links, function (a) {
      var there = new URL(a.href, location.href).pathname.replace(/\/(index\.html)?$/, '/');
      if (there === here) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }
  markCurrentPage();

  // ---- soft navigation ---------------------------------------------------
  //
  // The background canvas and this script live outside <main>, and every page
  // shares the same shell.  So moving between pages can be done by fetching the
  // next one and swapping <main> for its <main>, rather than by loading a whole
  // new document.  The simulation is then never torn down: it carries on
  // mid-stroke across a navigation, which is not something a full page load can
  // do -- there, the only options are to restart it or to serialise the entire
  // field and restore it.
  //
  // Every failure path falls back to an ordinary navigation, so the links work
  // with JavaScript broken, disabled, or offline.
  //
  // A click is never ignored.  An earlier guard skipped the swap while a fetch
  // was already in flight, but the click had already been prevented by then, so
  // the link simply did nothing -- which is what made the buttons look dead.
  // Instead each navigation takes a ticket and a stale response is discarded,
  // so a second click supersedes the first rather than being dropped.
  // ---- analytics hooks ---------------------------------------------------
  //
  // Nothing is loaded from here: these only forward to a provider if one has
  // been added to the pages.  They exist because soft navigation breaks the
  // usual assumption that a pageview equals a script load -- moving between
  // pages no longer loads anything, so without this every visit would count as
  // a single pageview however much of the site someone read.
  function trackPageview() {
    try {
      var path = location.pathname + location.search;
      if (window.goatcounter && window.goatcounter.count) {
        window.goatcounter.count({ path: path, title: document.title, event: false });
      } else if (typeof window.plausible === 'function') {
        window.plausible('pageview', { u: location.href });
      } else if (typeof window.gtag === 'function') {
        window.gtag('event', 'page_view', { page_path: path, page_title: document.title });
      }
    } catch (e) {}
  }

  // Outbound links, the CV and the paper links are the things worth counting on
  // a page like this -- they are what someone does instead of reading on.
  function trackEvent(name) {
    try {
      if (window.goatcounter && window.goatcounter.count) {
        window.goatcounter.count({ path: name, title: name, event: true });
      } else if (typeof window.plausible === 'function') {
        window.plausible(name);
      } else if (typeof window.gtag === 'function') {
        window.gtag('event', 'click', { link_url: name });
      }
    } catch (e) {}
  }

  var navToken = 0;

  // Over file:// a fetch of a sibling page is blocked as a cross-origin
  // request, so every link would fall back to a full load.  Better to leave the
  // links alone entirely and say why once.
  var canSoftNavigate = location.protocol !== 'file:' && typeof fetch === 'function';
  if (!canSoftNavigate) {
    console.warn('[nav] soft navigation is off (' +
      (location.protocol === 'file:' ? 'opened over file://, not from a server'
                                     : 'fetch unavailable') +
      '), so changing pages will restart the background simulation.');
  }

  function swapTo(url, push) {
    var token = ++navToken;
    fetch(url, { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.text();
      })
      .then(function (html) {
        if (token !== navToken) return;          // a later click won't be undone
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var main = doc.querySelector('main'), nav = doc.querySelector('nav.nav');
        var here = document.querySelector('main');
        if (!main || !here) throw new Error('unexpected page shape');
        here.replaceWith(main);
        if (nav) {
          var oldNav = document.querySelector('nav.nav');
          if (oldNav) oldNav.replaceWith(nav);
        }
        if (doc.title) document.title = doc.title;
        if (push) history.pushState({ soft: true }, '', url);
        window.scrollTo(0, 0);
        initReveals();
        markCurrentPage();
        trackPageview();          // the provider's own script only sees the first load
      })
      .catch(function (err) {
        // Last resort only: a full load, which does reset the background.  Say
        // so, because a silent fallback looks exactly like the router not
        // working -- and the commonest cause, opening the files over file://
        // rather than from a server, gives no other clue.
        console.warn('[nav] soft navigation failed, doing a full page load ' +
                     '(this resets the background simulation):', err);
        if (token === navToken) location.href = url;
      });
  }

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (!a || !a.href) return;

    var url;
    try { url = new URL(a.href, location.href); } catch (err) { return; }

    // Count what someone leaves for, whether or not the click is intercepted.
    if (url.origin !== location.origin) trackEvent('outbound: ' + url.host + url.pathname);
    else if (/\.pdf$/i.test(url.pathname)) trackEvent('cv: ' + url.pathname);

    if (!canSoftNavigate) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (a.target && a.target !== '_self') return;
    if (a.hasAttribute('download')) return;
    if (url.origin !== location.origin) return;
    // Leave in-page anchors and anything that is not one of these pages --
    // the CV is a PDF and should open the way the browser wants to open it.
    if (!/(^|\/)[\w.-]*\.html$|\/$/.test(url.pathname)) return;
    if (url.pathname === location.pathname && url.hash) return;

    e.preventDefault();
    if (url.pathname === location.pathname) { window.scrollTo(0, 0); return; }
    swapTo(url.href, true);
  });

  window.addEventListener('popstate', function () { swapTo(location.href, false); });

  // ---- smooth wheel scrolling --------------------------------------------
  //
  // CSS scroll-behavior only smooths programmatic and anchor jumps; a mouse
  // wheel is a sequence of discrete notches and the browser applies each one
  // instantly.  Easing toward a target position instead is the only way to
  // smooth it, which means taking the wheel over.
  //
  // Two things it deliberately does not touch.  Trackpads already send fine
  // pixel deltas with their own momentum, so smoothing them again feels
  // sluggish -- anything that looks like a trackpad is left to the browser.
  // And keyboard paging, Home/End, the scrollbar and anchor links are all
  // untouched, because those are scroll positions the browser sets directly
  // and this only resyncs to them.
  var SMOOTH_WHEEL = true;
  var WHEEL_EASE = 0.18;          // fraction of the remaining distance per frame
  var reduceMotion = false;
  try {
    reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) {}

  if (SMOOTH_WHEEL && !reduceMotion) {
    var wheelTarget = window.scrollY, wheelRaf = 0;

    function maxScroll() {
      return Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    }

    function wheelStep() {
      var cur = window.scrollY, d = wheelTarget - cur;
      if (Math.abs(d) < 0.5) { wheelRaf = 0; window.scrollTo(0, wheelTarget); return; }
      window.scrollTo(0, cur + d * WHEEL_EASE);
      wheelRaf = requestAnimationFrame(wheelStep);
    }

    window.addEventListener('wheel', function (e) {
      if (e.ctrlKey || e.defaultPrevented) return;          // pinch zoom
      // deltaMode 1 is lines (a mouse); mode 0 with a big jump is also a mouse.
      // Small pixel deltas mean a trackpad, which is already smooth.
      var isMouse = e.deltaMode === 1 || Math.abs(e.deltaY) >= 50;
      if (!isMouse) { wheelTarget = window.scrollY; return; }

      e.preventDefault();
      var delta = e.deltaY * (e.deltaMode === 1 ? 16 : 1);
      wheelTarget = Math.min(Math.max(wheelTarget + delta, 0), maxScroll());
      if (!wheelRaf) wheelRaf = requestAnimationFrame(wheelStep);
    }, { passive: false });

    // Anything that moves the page by other means -- keys, the scrollbar, an
    // anchor, a soft navigation -- becomes the new starting point.
    window.addEventListener('scroll', function () {
      if (!wheelRaf) wheelTarget = window.scrollY;
    }, { passive: true });
  }
})();
