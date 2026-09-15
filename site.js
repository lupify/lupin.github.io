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
    if (!canSoftNavigate) return;
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (!a || !a.href) return;
    if (a.target && a.target !== '_self') return;
    if (a.hasAttribute('download')) return;

    var url;
    try { url = new URL(a.href, location.href); } catch (err) { return; }
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
})();
