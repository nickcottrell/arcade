/*
 * CHROMAFALL -- browser port of roms/chromafall.sh
 *
 * Faithful to the ROM: 10x20 field, the same 7 tetrominoes with the same
 * pivot-relative rotation data, the same VRGB hue/sat/light per piece, the
 * same scoring curve and gravity ramp, the same wall-kick on rotate.
 *
 * The ROM emits a cue-mem token on each cleared line, tagged with the row's
 * dominant hue. The public arcade has no substrate to write to, so that
 * emission becomes a visible chroma flash + a "Chroma" counter -- the VRGB
 * identity kept as feel, not as a side effect on your token pool.
 */
(function () {
  "use strict";

  var FIELD_W = 10;
  var FIELD_H = 20;

  // Rotation tables, ported verbatim from the ROM (Px Ry).
  // Each entry: four [dx, dy] cells relative to the pivot.
  function cells(str) {
    var n = str.trim().split(/\s+/).map(Number);
    return [[n[0], n[1]], [n[2], n[3]], [n[4], n[5]], [n[6], n[7]]];
  }
  var PIECES = [
    null,
    { rot: ["-1 0 0 0 1 0 2 0", "0 -1 0 0 0 1 0 2", "-1 0 0 0 1 0 2 0", "0 -1 0 0 0 1 0 2"], hsl: [180, 80, 55] }, // I cyan
    { rot: ["0 0 1 0 0 1 1 1", "0 0 1 0 0 1 1 1", "0 0 1 0 0 1 1 1", "0 0 1 0 0 1 1 1"], hsl: [60, 80, 55] },      // O yellow
    { rot: ["-1 0 0 0 1 0 0 -1", "0 -1 0 0 0 1 1 0", "-1 0 0 0 1 0 0 1", "0 -1 0 0 0 1 -1 0"], hsl: [270, 70, 50] }, // T purple
    { rot: ["0 0 1 0 -1 1 0 1", "0 -1 0 0 1 0 1 1", "0 0 1 0 -1 1 0 1", "0 -1 0 0 1 0 1 1"], hsl: [120, 70, 50] },  // S green
    { rot: ["-1 0 0 0 0 1 1 1", "1 -1 1 0 0 0 0 1", "-1 0 0 0 0 1 1 1", "1 -1 1 0 0 0 0 1"], hsl: [0, 80, 50] },    // Z red
    { rot: ["-1 -1 -1 0 0 0 1 0", "0 -1 1 -1 0 0 0 1", "-1 0 0 0 1 0 1 1", "0 -1 0 0 -1 1 0 1"], hsl: [240, 80, 45] }, // J blue
    { rot: ["1 -1 -1 0 0 0 1 0", "0 -1 0 0 0 1 1 1", "-1 0 0 0 1 0 -1 1", "-1 -1 0 -1 0 0 0 1"], hsl: [30, 80, 55] }  // L orange
  ];
  // Pre-parse rotations into cell arrays.
  PIECES.forEach(function (p) {
    if (p) { p.rc = p.rot.map(cells); }
  });

  function hsl(a, dl) {
    var l = a[2] + (dl || 0);
    return "hsl(" + a[0] + ", " + a[1] + "%, " + l + "%)";
  }

  window.ArcadeShell.register("chromafall", {
    title: "Chromafall",
    controls: ["left", "right", "rotate", "soft", "drop"],
    keymap: {
      ArrowLeft: "left", ArrowRight: "right", ArrowUp: "rotate",
      ArrowDown: "soft", " ": "drop", Spacebar: "drop"
    },
    create: function (host) { return new Chromafall(host); }
  });

  function Chromafall(host) {
    this.host = host;
    this.ctx = host.ctx;
    this.canvas = host.canvas;
    this.field = new Array(FIELD_W * FIELD_H).fill(0);
    this.cur = 0; this.rot = 0; this.x = 0; this.y = 0;
    this.next = this._bag();
    this.score = 0; this.lines = 0; this.level = 1;
    this.chroma = 0;
    this.over = false;
    this.raf = null;
    this.lastT = 0; this.acc = 0;
    this.flash = null;   // { rows:[y...], hslStr, ttl }
    this.cell = 24;      // px per cell, set in resize()
    this.sized = false;  // true once the surface has a real measurable size
    this._spawn();
    this.next = this._bag();
  }

  Chromafall.prototype._bag = function () { return 1 + Math.floor(Math.random() * 7); };

  Chromafall.prototype._fits = function (p, r, px, py) {
    var rc = PIECES[p].rc[r];
    for (var i = 0; i < 4; i++) {
      var cx = px + rc[i][0], cy = py + rc[i][1];
      if (cx < 0 || cx >= FIELD_W) { return false; }
      if (cy >= FIELD_H) { return false; }
      if (cy >= 0 && this.field[cy * FIELD_W + cx] !== 0) { return false; }
    }
    return true;
  };

  Chromafall.prototype._spawn = function () {
    this.cur = this.next;
    this.next = this._bag();
    this.rot = 0;
    this.x = Math.floor(FIELD_W / 2);
    this.y = 0;
    if (!this._fits(this.cur, this.rot, this.x, this.y)) { this.over = true; }
  };

  Chromafall.prototype._lock = function () {
    var rc = PIECES[this.cur].rc[this.rot];
    for (var i = 0; i < 4; i++) {
      var cx = this.x + rc[i][0], cy = this.y + rc[i][1];
      if (cy >= 0 && cy < FIELD_H && cx >= 0 && cx < FIELD_W) {
        this.field[cy * FIELD_W + cx] = this.cur;
      }
    }
  };

  Chromafall.prototype._clearLines = function () {
    var cleared = 0;
    var flashRows = [];
    var domPiece = 1;
    var y = FIELD_H - 1;
    while (y >= 0) {
      var full = true;
      for (var x = 0; x < FIELD_W; x++) {
        if (this.field[y * FIELD_W + x] === 0) { full = false; break; }
      }
      if (full) {
        // Dominant piece (hue) in this row -- the ROM's token tag.
        var counts = [0, 0, 0, 0, 0, 0, 0, 0];
        for (x = 0; x < FIELD_W; x++) { counts[this.field[y * FIELD_W + x]]++; }
        var dom = 1, dc = 0;
        for (var ci = 1; ci <= 7; ci++) { if (counts[ci] > dc) { dom = ci; dc = counts[ci]; } }
        domPiece = dom;
        this.chroma++;
        flashRows.push(y);
        // Shift everything above down one row.
        for (var sy = y - 1; sy >= 0; sy--) {
          for (x = 0; x < FIELD_W; x++) {
            this.field[(sy + 1) * FIELD_W + x] = this.field[sy * FIELD_W + x];
          }
        }
        for (x = 0; x < FIELD_W; x++) { this.field[x] = 0; }
        cleared++;
        // Re-check same y (content shifted down).
      } else {
        y--;
      }
    }

    if (cleared > 0) {
      this.lines += cleared;
      var add = [0, 100, 300, 500, 800][Math.min(cleared, 4)];
      this.score += add * this.level;
      this.level = Math.floor(this.lines / 10) + 1;
      this.flash = { hslStr: hsl(PIECES[domPiece].hsl), ttl: 260 };
    }
    return cleared;
  };

  Chromafall.prototype._gravityMs = function () {
    var rate = 6 - this.level;   // ROM DROP_RATE, in ticks
    if (rate < 1) { rate = 1; }
    return rate * 130;
  };

  // --- Shell contract ----------------------------------------------------
  Chromafall.prototype.action = function (a) {
    if (this.over) { return; }
    if (a === "left") { if (this._fits(this.cur, this.rot, this.x - 1, this.y)) { this.x--; } }
    else if (a === "right") { if (this._fits(this.cur, this.rot, this.x + 1, this.y)) { this.x++; } }
    else if (a === "rotate") {
      var nr = (this.rot + 1) % 4;
      if (this._fits(this.cur, nr, this.x, this.y)) { this.rot = nr; }
      else if (this._fits(this.cur, nr, this.x - 1, this.y)) { this.rot = nr; this.x--; }
      else if (this._fits(this.cur, nr, this.x + 1, this.y)) { this.rot = nr; this.x++; }
    }
    else if (a === "soft") {
      if (this._fits(this.cur, this.rot, this.x, this.y + 1)) { this.y++; this.score++; this._sync(); }
    }
    else if (a === "drop") {
      while (this._fits(this.cur, this.rot, this.x, this.y + 1)) { this.y++; this.score += 2; }
      this._settle();
    }
  };

  Chromafall.prototype._settle = function () {
    this._lock();
    this._clearLines();
    this._spawn();
    this.acc = 0;
    this._sync();
  };

  Chromafall.prototype._sync = function () {
    this.host.setScore(this.score);
    this.host.setStat("Lines", this.lines);
    this.host.setStat("Level", this.level);
    this.host.setStat("Chroma", this.chroma);
  };

  Chromafall.prototype.start = function () {
    this._sync();
    var self = this;
    this.lastT = performance.now();
    var loop = function (t) {
      if (self.stopped) { return; }
      // Self-heal: don't run or draw until the surface has a real size. On iOS
      // the cabinet may not be measurable on the first frame after mount.
      if (!self.sized && !self.resize()) {
        self.lastT = t;
        self.raf = requestAnimationFrame(loop);
        return;
      }
      var dt = t - self.lastT;
      self.lastT = t;
      if (!self.over) {
        self.acc += dt;
        var g = self._gravityMs();
        while (self.acc >= g) {
          self.acc -= g;
          if (self._fits(self.cur, self.rot, self.x, self.y + 1)) { self.y++; }
          else { self._settle(); }
        }
      }
      if (self.flash) { self.flash.ttl -= dt; if (self.flash.ttl <= 0) { self.flash = null; } }
      self._draw();
      if (self.over && !self._announced) {
        self._announced = true;
        self.host.gameOver({
          title: "Stack Overflow",
          lines: ["Score " + self.score, "Lines " + self.lines,
                  "Level " + self.level, "Chroma emitted " + self.chroma]
        });
      }
      self.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  };

  Chromafall.prototype.stop = function () {
    this.stopped = true;
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; }
  };

  Chromafall.prototype.resize = function () {
    var surface = this.canvas.parentElement;
    if (!surface) { return false; }
    var maxW = surface.clientWidth;
    var maxH = surface.clientHeight;
    // Layout not settled yet (just-unhidden cabinet, dvh not resolved): bail and
    // let the game loop retry next frame. Prevents a 0-size canvas that renders
    // nothing -- the "game not rendering" bug on real iOS Safari.
    if (maxW < 20 || maxH < 20) { return false; }
    // Fit a 10x20 grid, integer cell size, into the available box.
    var cell = Math.floor(Math.min(maxW / FIELD_W, maxH / FIELD_H));
    if (cell < 6) { cell = 6; }
    this.cell = cell;
    var dpr = window.devicePixelRatio || 1;
    this.canvas.width = FIELD_W * cell * dpr;
    this.canvas.height = FIELD_H * cell * dpr;
    this.canvas.style.width = (FIELD_W * cell) + "px";
    this.canvas.style.height = (FIELD_H * cell) + "px";
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.sized = true;
    return true;
  };

  Chromafall.prototype._draw = function () {
    var ctx = this.ctx, c = this.cell;
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, FIELD_W * c, FIELD_H * c);

    // Placed cells (dimmed).
    for (var y = 0; y < FIELD_H; y++) {
      for (var x = 0; x < FIELD_W; x++) {
        var id = this.field[y * FIELD_W + x];
        if (id !== 0) { this._block(x, y, hsl(PIECES[id].hsl, -8)); }
      }
    }

    // Active piece (bright).
    if (!this.over) {
      var rc = PIECES[this.cur].rc[this.rot];
      for (var i = 0; i < 4; i++) {
        var cx = this.x + rc[i][0], cy = this.y + rc[i][1];
        if (cy >= 0) { this._block(cx, cy, hsl(PIECES[this.cur].hsl, 8)); }
      }
    }

    // Line-clear chroma flash: a full-width wash in the dominant hue.
    if (this.flash) {
      var alpha = Math.max(0, this.flash.ttl / 260);
      ctx.globalAlpha = alpha * 0.5;
      ctx.fillStyle = this.flash.hslStr;
      ctx.fillRect(0, 0, FIELD_W * c, FIELD_H * c);
      ctx.globalAlpha = 1;
    }
  };

  Chromafall.prototype._block = function (x, y, color) {
    var ctx = this.ctx, c = this.cell;
    ctx.fillStyle = color;
    ctx.fillRect(x * c + 1, y * c + 1, c - 2, c - 2);
  };
})();
