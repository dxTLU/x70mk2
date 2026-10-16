// Runs inside proxied pages. `x70` is this plugin's helper (see plugins/README.md).
var STYLE_ID = 'x70-dark-mode';
var s = x70.settings;
var site = (function () { try { return new URL(x70.url()).hostname; } catch (e) { return ''; } })();
var key = 'site:' + site;

function css() {
  var f = 'invert(1) hue-rotate(180deg)';
  return 'html{filter:' + f + ' brightness(' + (s.brightness / 100) + ') contrast(' + (s.contrast / 100) + ') !important;background:#fff !important}' +
    'img,video,picture,canvas,svg image,iframe,embed,object,[style*="background-image"],proxy-toolbar{filter:' + f + ' !important}';
}

function apply(on) {
  var el = document.getElementById(STYLE_ID);
  if (on && !el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css();
    (document.head || document.documentElement).appendChild(el);
  } else if (!on && el) {
    el.remove();
  }
}

function wanted() { return x70.storage.get(key, Boolean(s.auto)); }

apply(wanted());
// Pages that rebuild <head> would drop the style: put it back.
document.addEventListener('DOMContentLoaded', function () { apply(wanted()); });

x70.onToolbar('toggle', function () {
  var on = !wanted();
  x70.storage.set(key, on);
  apply(on);
});
