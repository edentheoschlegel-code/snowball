/* Sets the theme before first paint so there's no light→dark flash.
 * Loaded synchronously in <head> as an external file (the app's strict CSP
 * blocks inline scripts). Values in "snowball.theme": "light" | "dark" |
 * "system" (default/unset = follow the OS preference). */
(function () {
  try {
    var pref = localStorage.getItem("snowball.theme");
    var dark = pref === "dark" || ((pref === "system" || !pref) &&
      window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    if (dark) document.documentElement.setAttribute("data-theme", "dark");
  } catch (e) { /* private-browsing / storage blocked — default light */ }
})();
