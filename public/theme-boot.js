/*
 * Pre-paint theme boot.
 *
 * A classic (blocking) script in <head>, executed before the body is parsed, so the first frame is
 * already the saved edition. It is a file rather than an inline snippet because the renderer's CSP
 * is `script-src 'self'` with no 'unsafe-inline'; keeping it external also means no hash to
 * maintain every time this text changes.
 *
 * It must agree with src/theme/storage.ts on three things: the key names, the accepted theme ids
 * and the accepted modes. Those are deliberately the smallest possible surface - plain strings.
 */
(function boot() {
  var THEMES = [
    "default",
    "echo-net",
    "mil-sim",
    "cyberpunk",
    "synthwave",
    "retro",
    "neo-industrialist",
    "cassette-futurism",
    "neo-brutalism",
  ];

  var root = document.documentElement;
  var theme = "default";
  var mode = "system";
  var settings = null;

  try {
    var savedTheme = window.localStorage.getItem("aegis.theme.v1");
    if (savedTheme && THEMES.indexOf(savedTheme) !== -1) theme = savedTheme;

    var savedMode = window.localStorage.getItem("aegis.mode.v1");
    if (savedMode === "light" || savedMode === "dark" || savedMode === "system") {
      mode = savedMode;
    } else {
      // Migration: builds before the theme system stored the mode as `appearance.theme`.
      settings = JSON.parse(window.localStorage.getItem("aegis.settings.v1") || "null");
      var legacyMode = settings && settings.appearance && settings.appearance.theme;
      if (legacyMode === "light" || legacyMode === "dark" || legacyMode === "system") {
        mode = legacyMode;
        window.localStorage.setItem("aegis.mode.v1", mode);
      }
    }
  } catch (error) {
    /* storage blocked: fall through to the defaults instead of failing to boot */
  }

  var resolved = mode;
  if (mode === "system") {
    try {
      resolved = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch (error) {
      resolved = "dark";
    }
  }

  root.setAttribute("data-theme", theme);
  root.setAttribute("data-mode", resolved);

  /*
   * The rest of the appearance document is applied here too: a React effect would run after the
   * first paint, which is a visible jump in row density for anyone who chose compact.
   */
  try {
    if (!settings) settings = JSON.parse(window.localStorage.getItem("aegis.settings.v1") || "null");
    var appearance = settings && settings.appearance;
    if (!appearance) return;

    /*
     * The accent is absent on purpose. A named hue is only half of it: the two readable shades are
     * measured against the edition's page colour, which needs the theme to be resolved first, and a
     * `data-accent` without those variables would paint invalid colours. `useAppearance` owns it.
     */
    var attributes = {
      density: "density",
      messageSize: "messageSize",
      font: "font",
      motion: "motion",
      texture: "texture",
    };

    Object.keys(attributes).forEach(function (key) {
      var value = appearance[key];
      if (typeof value === "string" && value.length > 0) {
        root.setAttribute("data-" + attributes[key].replace(/[A-Z]/g, function (letter) {
          return "-" + letter.toLowerCase();
        }), value);
      }
    });
  } catch (error) {
    /* a corrupt document is not a reason to show an unthemed page */
  }
})();
