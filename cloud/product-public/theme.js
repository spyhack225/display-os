(function () {
  'use strict';
  var KEY = 'theme';
  var COLORS = { dark: '#0a0a0b', light: '#ffffff' };
  var root = document.documentElement;
  function stored() {
    try { var value = localStorage.getItem(KEY); return value === 'dark' || value === 'light' ? value : null; } catch (_) { return null; }
  }
  function systemTheme() {
    try { return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; } catch (_) { return 'dark'; }
  }
  function fallback() { return root.getAttribute('data-theme-default') || systemTheme(); }
  function current() { return stored() || fallback(); }
  function setClass(name) {
    var rest = (root.className || '').replace(/(^|\s)(dark|light)(?=\s|$)/g, ' ').replace(/\s+/g, ' ').replace(/^\s|\s$/g, '');
    root.className = name ? (rest ? rest + ' ' : '') + name : rest;
  }
  function setMeta(name) {
    var tags = document.querySelectorAll('meta[name="theme-color"]');
    for (var index = tags.length - 1; index >= 0; index--) {
      if (index) tags[index].parentNode.removeChild(tags[index]);
      else { tags[index].setAttribute('content', COLORS[name]); tags[index].removeAttribute('media'); }
    }
  }
  // Runs before first paint. A saved choice wins. The tablet screen declares a
  // dark default. Everything else follows the system through CSS alone.
  var saved = stored();
  var preset = root.getAttribute('data-theme-default');
  if (saved) { setClass(saved); setMeta(saved); }
  else if (preset) setClass(preset);

  function label(button) {
    var next = current() === 'dark' ? 'light' : 'dark';
    button.setAttribute('aria-label', 'Switch to ' + next + ' theme');
    button.setAttribute('title', 'Switch to ' + next + ' theme');
  }
  function wire() {
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    if (!buttons.length) return;
    root.className += (root.className ? ' ' : '') + 'theme-ready';
    Array.prototype.forEach.call(buttons, function (button) {
      label(button);
      button.addEventListener('click', function () {
        var next = current() === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(KEY, next); } catch (_) {}
        setClass(next); setMeta(next);
        Array.prototype.forEach.call(buttons, label);
      });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
}());
