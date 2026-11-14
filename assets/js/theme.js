// Apply one of five bundled themes before first paint.
// Loaded as a classic script in <head> so the saved theme applies before
// first paint. Any <select data-theme-picker> on the page is wired up.
(function () {
  var KEY = 'agentglade.theme';
  var THEMES = ['mocha', 'macchiato', 'frappe', 'latte', 'terminal'];
  var root = document.documentElement;

  function valid(t) { return THEMES.indexOf(t) >= 0 ? t : 'mocha'; }

  function syncChrome() {
    var meta = document.querySelector('meta[name="theme-color"]');
    var ink = getComputedStyle(root).getPropertyValue('--ink-soft').trim();
    if (meta && ink) meta.setAttribute('content', ink);
    document.querySelectorAll('[data-theme-picker]').forEach(function (s) { s.value = root.dataset.theme; });
  }

  function apply(t) { root.dataset.theme = valid(t); syncChrome(); }

  try { var saved = localStorage.getItem(KEY); if (saved) root.dataset.theme = valid(saved); } catch (e) {}

  document.addEventListener('DOMContentLoaded', function () {
    syncChrome();
    document.querySelectorAll('[data-theme-picker]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        apply(sel.value);
        try { localStorage.setItem(KEY, root.dataset.theme); } catch (e) {}
      });
    });
  });

  // Keep other open tabs (and the installed composer) in step.
  window.addEventListener('storage', function (e) { if (e.key === KEY && e.newValue) apply(e.newValue); });
})();
