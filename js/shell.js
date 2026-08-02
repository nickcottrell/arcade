/*
 * ARCADE SHELL -- the public browser arcade frame.
 *
 * Separation of concerns: the shell owns everything that is NOT a game --
 * the dynamic manifest fetch, the picker, the cabinet frame, the scoreboard,
 * and a single input bus (keyboard + on-screen touch pad) that translates
 * device events into abstract actions. A game never touches the keyboard or
 * the DOM chrome; it registers a mechanic and receives actions. That keeps
 * every port composable -- the same contract for Chromafall, Heat Trail, Chess.
 *
 * Game contract (see js/games/chromafall.js):
 *   ArcadeShell.register(id, {
 *     title, controls: ['left','right','rotate','soft','drop'],
 *     create: function (host) { return instance; }
 *   });
 * Instance: { start(), stop(), action(name) }
 * Host (passed to create): { canvas, ctx, setScore, setStat, gameOver, palette }
 */
(function () {
  "use strict";

  var MANIFEST_URL = "data/manifest.json";

  var registry = {};       // id -> game definition
  var loaded = {};         // id -> true once its module script has run
  var active = null;       // current mounted instance
  var activeDef = null;

  // --- DOM handles -------------------------------------------------------
  var els = {};
  function $(id) { return document.getElementById(id); }

  // --- Public registration API (games call this) -------------------------
  var ArcadeShell = {
    register: function (id, def) { registry[id] = def; loaded[id] = true; }
  };
  window.ArcadeShell = ArcadeShell;

  // --- Manifest + picker -------------------------------------------------
  function boot() {
    els.picker = $("picker");
    els.grid = $("game-grid");
    els.cabinet = $("cabinet");
    els.title = $("cabinet-title");
    els.surface = $("surface");
    els.score = $("score-value");
    els.stats = $("stat-row");
    els.pad = $("control-pad");
    els.back = $("back-btn");
    els.tagline = $("arcade-tagline");

    els.back.addEventListener("click", toPicker);

    var bust = "?v=" + Date.now();
    fetch(MANIFEST_URL + bust)
      .then(function (r) { return r.json(); })
      .then(renderPicker)
      .catch(function () {
        els.grid.innerHTML =
          '<p class="arcade-error">Could not load the game manifest.</p>';
      });
  }

  function renderPicker(manifest) {
    if (manifest.tagline) { els.tagline.textContent = manifest.tagline; }
    var games = (manifest.games || []).filter(function (g) {
      return g.status === "live";
    });
    els.grid.innerHTML = "";
    if (!games.length) {
      els.grid.innerHTML = '<p class="arcade-empty">No games live yet.</p>';
      return;
    }
    games.forEach(function (g) {
      var card = document.createElement("button");
      card.className = "game-card";
      card.type = "button";
      card.innerHTML =
        '<span class="game-card__title">' + esc(g.title) + "</span>" +
        '<span class="game-card__blurb">' + esc(g.blurb || "") + "</span>" +
        '<span class="game-card__cta">Play &rsaquo;</span>';
      card.addEventListener("click", function () { launch(g); });
      els.grid.appendChild(card);
    });
  }

  // --- Launch / mount ----------------------------------------------------
  function launch(g) {
    if (loaded[g.id]) { return mount(g); }
    var s = document.createElement("script");
    s.src = g.module + "?v=" + Date.now();
    s.onload = function () { mount(g); };
    s.onerror = function () {
      alert("Failed to load game: " + g.title);
    };
    document.body.appendChild(s);
  }

  function mount(g) {
    var def = registry[g.id];
    if (!def) { alert("Game did not register: " + g.id); return; }
    activeDef = def;

    els.title.textContent = def.title || g.title;
    els.score.textContent = "0";
    els.stats.innerHTML = "";

    // Fresh canvas each mount -- games own their pixels, not their chrome.
    els.surface.innerHTML = "";
    var canvas = document.createElement("canvas");
    canvas.className = "game-canvas";
    els.surface.appendChild(canvas);

    buildPad(def.controls || []);

    var host = makeHost(canvas);
    active = def.create(host);

    show(els.cabinet, els.picker);
    // Size after the cabinet is visible so layout is measurable.
    if (active.resize) { active.resize(); }
    active.start();
    bindKeys(true);
    bindResize(true);
  }

  function toPicker() {
    bindKeys(false);
    bindResize(false);
    if (active && active.stop) { active.stop(); }
    active = null;
    activeDef = null;
    els.surface.innerHTML = "";
    show(els.picker, els.cabinet);
  }

  // --- Host given to each game ------------------------------------------
  function makeHost(canvas) {
    return {
      canvas: canvas,
      ctx: canvas.getContext("2d"),
      setScore: function (n) { els.score.textContent = String(n); },
      setStat: function (name, value) { renderStat(name, value); },
      gameOver: function (summary) { showGameOver(summary); },
      palette: {}   // reserved for VRGB theme injection
    };
  }

  var statCells = {};
  function renderStat(name, value) {
    var cell = statCells[name];
    if (!cell) {
      cell = document.createElement("div");
      cell.className = "stat";
      cell.innerHTML =
        '<span class="stat__label">' + esc(name) + "</span>" +
        '<span class="stat__value"></span>';
      els.stats.appendChild(cell);
      statCells[name] = cell;
    }
    cell.querySelector(".stat__value").textContent = String(value);
  }

  function showGameOver(summary) {
    var over = document.createElement("div");
    over.className = "game-over";
    var lines = "";
    (summary.lines || []).forEach(function (l) {
      lines += "<li>" + esc(l) + "</li>";
    });
    over.innerHTML =
      '<div class="game-over__panel">' +
        '<h2 class="game-over__title">' + esc(summary.title || "Game Over") + "</h2>" +
        "<ul class=\"game-over__stats\">" + lines + "</ul>" +
        '<div class="game-over__actions">' +
          '<button class="btn btn--primary" id="go-again">Play again</button>' +
          '<button class="btn btn--secondary" id="go-menu">Menu</button>' +
        "</div>" +
      "</div>";
    els.surface.appendChild(over);
    $("go-again").addEventListener("click", function () {
      over.remove();
      if (active && active.stop) { active.stop(); }
      active = activeDef.create(makeHostFromCurrentCanvas());
      if (active.resize) { active.resize(); }
      active.start();
    });
    $("go-menu").addEventListener("click", toPicker);
  }

  function makeHostFromCurrentCanvas() {
    statCells = {};
    els.stats.innerHTML = "";
    els.score.textContent = "0";
    var canvas = els.surface.querySelector(".game-canvas");
    return makeHost(canvas);
  }

  // --- Input bus: keyboard + touch pad -> abstract actions ---------------
  var KEYMAP = {
    ArrowLeft: "left", ArrowRight: "right", ArrowUp: "rotate",
    ArrowDown: "soft", " ": "drop", Spacebar: "drop"
  };

  function onKey(e) {
    var a = KEYMAP[e.key];
    if (!a) { return; }
    e.preventDefault();
    dispatch(a);
  }

  function bindKeys(on) {
    if (on) { document.addEventListener("keydown", onKey); }
    else { document.removeEventListener("keydown", onKey); }
  }

  function dispatch(action) {
    if (active && active.action) { active.action(action); }
  }

  // Refit the canvas when the visible viewport changes -- iOS Safari showing or
  // hiding its toolbar fires resize, as does rotation.
  function onResize() { if (active && active.resize) { active.resize(); } }
  function bindResize(on) {
    if (on) {
      window.addEventListener("resize", onResize);
      window.addEventListener("orientationchange", onResize);
    } else {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    }
  }

  var LABELS = {
    left: "←", right: "→", rotate: "↺",
    soft: "↓", drop: "⤓"
  };

  function buildPad(controls) {
    els.pad.innerHTML = "";
    controls.forEach(function (name) {
      var b = document.createElement("button");
      b.className = "pad-btn pad-btn--" + name;
      b.type = "button";
      b.textContent = LABELS[name] || name;
      b.setAttribute("aria-label", name);
      // Pointer events cover both touch and mouse; repeat while held for moves.
      var timer = null;
      var repeatable = (name === "left" || name === "right" || name === "soft");
      b.addEventListener("pointerdown", function (e) {
        e.preventDefault();
        dispatch(name);
        if (repeatable) {
          timer = setInterval(function () { dispatch(name); }, 90);
        }
      });
      function release() {
        if (timer) { clearInterval(timer); timer = null; }
      }
      b.addEventListener("pointerup", release);
      b.addEventListener("pointerleave", release);
      b.addEventListener("pointercancel", release);
      els.pad.appendChild(b);
    });
  }

  // --- helpers -----------------------------------------------------------
  function show(shown, hidden) {
    hidden.hidden = true;
    shown.hidden = false;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
