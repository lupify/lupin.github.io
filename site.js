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

  // Hairline under the top bar once the page scrolls.
  var topbar = document.getElementById('topbar');
  if (topbar) {
    var onScroll = function () { topbar.dataset.stuck = window.scrollY > 8; };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  // Reveal on entry.
  var items = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) {
    Array.prototype.forEach.call(items, function (el) { el.classList.add('is-in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { entry.target.classList.add('is-in'); io.unobserve(entry.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    Array.prototype.forEach.call(items, function (el) { io.observe(el); });
  }
})();
