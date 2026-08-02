/*
 * CHAIN CHOMP -- browser port of roms/chain-chomp.sh
 *
 * Pac-Man meets provenance chains. Faithful to the ROM:
 *   - The same 21x11 maze template (# wall, . dot, o power pellet).
 *   - Thermal dot decay: dots have heat hot(3) -> warm(2) -> cold(1) -> gone(0)
 *     and cool on a timer; hotter dots are worth more, so you naturally eat the
 *     hottest first. Rendered by color/brightness.
 *   - Provenance CHAIN: consecutive eats build a multiplier (1 + chain/5). A
 *     ghost hit BREAKS the chain, costs a life, and can end the game.
 *   - Ghosts chase (greedy pursuit, prefer larger-distance axis, 30% jitter),
 *     flip and flee while a power pellet is active, and speed up per level.
 *
 * The ROM writes cue-mem tokens (chain heat, ghost_kill, chain_break) as a side
 * effect on the token pool. The public arcade has no substrate to write to, so
 * that provenance identity is kept as FEEL -- the on-screen Chain multiplier,
 * the ghost-eat flash, and the chain-break shudder -- not as a pool mutation.
 */
(function () {
  "use strict";

  var MAP_W = 21;
  var MAP_H = 11;

  var MAP_TMPL = [
    "#####################",
    "#o........#........o#",
    "#.###.##..#..##.###.#",
    "#...................#",
    "#.#.#.#.#####.#.#.#.#",
    "#.....#.......#.....#",
    "#.#.#.#.#####.#.#.#.#",
    "#...................#",
    "#.###.##..#..##.###.#",
    "#o........#........o#",
    "#####################"
  ];

  var START_PX = 10;
  var START_PY = 7;
  var GHOST_STARTS = [[5, 5], [15, 5]];
  var NUM_GHOSTS = 2;

  // Token codes on a cell: 0 none, 1 cold, 2 warm, 3 hot, 9 power pellet.
  // Base values track the ROM (10/20/30/50).
  function baseValue(t) {
    if (t === 1) { return 10; }
    if (t === 2) { return 20; }
    if (t === 3) { return 30; }
    if (t === 9) { return 50; }
    return 0;
  }

  window.ArcadeShell.register("chomp", {
    title: "Chain Chomp",
    controls: ["up", "down", "left", "right"],
    keymap: {
      ArrowLeft: "left", ArrowRight: "right",
      ArrowUp: "up", ArrowDown: "down"
    },
    create: function (host) { return new Chomp(host); }
  });

  function Chomp(host) {
    this.host = host;
    this.ctx = host.ctx;
    this.canvas = host.canvas;

    this.wall = new Array(MAP_W * MAP_H).fill(0);
    this.token = new Array(MAP_W * MAP_H).fill(0);
    this.tokensLeft = 0;

    this.px = START_PX; this.py = START_PY;
    this.pdir = "left";           // facing, for the chomp mouth
    this.gx = []; this.gy = [];
    this.scared = 0;              // ticks of power mode remaining

    this.score = 0;
    this.chain = 0;
    this.bestChain = 0;
    this.lives = 3;
    this.level = 1;
    this.tick = 0;
    this.over = false;

    this.flash = null;            // { color, ttl } eat/ghost-kill wash
    this.shudder = 0;             // ms of chain-break shudder remaining

    this.cell = 20;               // px per cell, set in resize()
    this.sized = false;
    this.raf = null;
    this.stopped = false;
    this.lastT = 0;
    this.acc = 0;                 // ms accumulator for the game tick
    this.announced = false;

    this._initLevel();
  }

  Chomp.prototype._initLevel = function () {
    this.tokensLeft = 0;
    for (var y = 0; y < MAP_H; y++) {
      var row = MAP_TMPL[y];
      for (var x = 0; x < MAP_W; x++) {
        var idx = y * MAP_W + x;
        var ch = row.charAt(x);
        if (ch === "#") { this.wall[idx] = 1; this.token[idx] = 0; }
        else if (ch === ".") { this.wall[idx] = 0; this.token[idx] = 3; this.tokensLeft++; }
        else if (ch === "o") { this.wall[idx] = 0; this.token[idx] = 9; this.tokensLeft++; }
        else { this.wall[idx] = 0; this.token[idx] = 0; }
      }
    }
    this.px = START_PX; this.py = START_PY;
    this.gx = []; this.gy = [];
    for (var i = 0; i < NUM_GHOSTS; i++) {
      this.gx[i] = GHOST_STARTS[i][0];
      this.gy[i] = GHOST_STARTS[i][1];
    }
    this.scared = 0;
    this.tick = 0;
  };

  Chomp.prototype._canMove = function (x, y) {
    if (x < 0 || x >= MAP_W) { return false; }
    if (y < 0 || y >= MAP_H) { return false; }
    if (this.wall[y * MAP_W + x] === 1) { return false; }
    return true;
  };

  // --- Shell contract ----------------------------------------------------
  Chomp.prototype.action = function (a) {
    if (this.over) { return; }
    var dx = 0, dy = 0;
    if (a === "up") { dy = -1; this.pdir = "up"; }
    else if (a === "down") { dy = 1; this.pdir = "down"; }
    else if (a === "left") { dx = -1; this.pdir = "left"; }
    else if (a === "right") { dx = 1; this.pdir = "right"; }
    else { return; }
    this._movePlayer(dx, dy);
  };

  Chomp.prototype._movePlayer = function (dx, dy) {
    var nx = this.px + dx, ny = this.py + dy;
    if (!this._canMove(nx, ny)) { return; }
    this.px = nx; this.py = ny;
    this._pickup();
    if (!this.over) { this._checkCollision(); }
    this._sync();
  };

  Chomp.prototype._pickup = function () {
    var idx = this.py * MAP_W + this.px;
    var t = this.token[idx];
    if (t === 0) { return; }

    this.chain++;
    if (this.chain > this.bestChain) { this.bestChain = this.chain; }

    var mult = 1 + Math.floor(this.chain / 5);
    this.score += baseValue(t) * mult;
    this.token[idx] = 0;
    this.tokensLeft--;

    // Provenance-as-feel: brief wash tinted by the dot's heat.
    var color = t === 9 ? "#c77dff"
      : t === 3 ? "#ff4d4d"
        : t === 2 ? "#ffd24d"
          : "#8899aa";
    this.flash = { color: color, ttl: 140 };

    if (t === 9) { this.scared = 35; }

    if (this.tokensLeft <= 0) { this._advanceLevel(); }
  };

  Chomp.prototype._advanceLevel = function () {
    this.level++;
    if (this.level % 3 === 0 && this.lives < 5) { this.lives++; }
    this._initLevel();
  };

  Chomp.prototype._checkCollision = function () {
    for (var i = 0; i < NUM_GHOSTS; i++) {
      if (this.gx[i] === this.px && this.gy[i] === this.py) {
        this._resolveGhost(i);
        if (this.over) { return; }
      }
    }
  };

  // Shared ghost/player overlap resolution (ROM has this in two places).
  Chomp.prototype._resolveGhost = function (i) {
    if (this.scared > 0) {
      this.score += 200 * this.level;
      this.gx[i] = 10; this.gy[i] = 5;
      this.flash = { color: "#66ffcc", ttl: 180 };
    } else {
      this.chain = 0;
      this.lives--;
      this.px = START_PX; this.py = START_PY;
      this.shudder = 320;
      this.flash = { color: "#ff2222", ttl: 220 };
      if (this.lives <= 0) { this.over = true; }
    }
  };

  // --- Ghost AI (greedy pursuit, ROM-faithful) ---------------------------
  Chomp.prototype._moveGhosts = function () {
    for (var i = 0; i < NUM_GHOSTS; i++) {
      var gx = this.gx[i], gy = this.gy[i];

      var dx = 0, dy = 0;
      if (this.px > gx) { dx = 1; } else if (this.px < gx) { dx = -1; }
      if (this.py > gy) { dy = 1; } else if (this.py < gy) { dy = -1; }

      // Flee when scared.
      if (this.scared > 0) { dx = -dx; dy = -dy; }

      // 30% random jitter.
      if (Math.floor(Math.random() * 10) < 3) {
        var roll = Math.floor(Math.random() * 4);
        if (roll === 0) { dx = 1; dy = 0; }
        else if (roll === 1) { dx = -1; dy = 0; }
        else if (roll === 2) { dx = 0; dy = 1; }
        else { dx = 0; dy = -1; }
      }

      var moved = false;
      var adx = dx < 0 ? -dx : dx;
      var ady = dy < 0 ? -dy : dy;

      if (adx >= ady) {
        if (dx !== 0 && this._canMove(gx + dx, gy)) { this.gx[i] = gx + dx; moved = true; }
        else if (dy !== 0 && this._canMove(gx, gy + dy)) { this.gy[i] = gy + dy; moved = true; }
      } else {
        if (dy !== 0 && this._canMove(gx, gy + dy)) { this.gy[i] = gy + dy; moved = true; }
        else if (dx !== 0 && this._canMove(gx + dx, gy)) { this.gx[i] = gx + dx; moved = true; }
      }

      // If stuck, try any open direction.
      if (!moved) {
        var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        var start = Math.floor(Math.random() * 4);
        for (var d = 0; d < 4; d++) {
          var pick = (start + d) % 4;
          var tdx = dirs[pick][0], tdy = dirs[pick][1];
          if (this._canMove(gx + tdx, gy + tdy)) {
            this.gx[i] = gx + tdx; this.gy[i] = gy + tdy;
            break;
          }
        }
      }

      // Collision after the ghost moved.
      if (this.gx[i] === this.px && this.gy[i] === this.py) {
        this._resolveGhost(i);
        if (this.over) { return; }
      }
    }
  };

  // --- Thermal decay -----------------------------------------------------
  Chomp.prototype._decay = function () {
    var total = MAP_W * MAP_H;
    for (var i = 0; i < total; i++) {
      var t = this.token[i];
      if (t >= 1 && t <= 3) {
        this.token[i] = t - 1;
        if (this.token[i] === 0) { this.tokensLeft--; }
      }
    }
    if (this.tokensLeft <= 0) { this.level++; this._initLevel(); }
  };

  Chomp.prototype._sync = function () {
    this.host.setScore(this.score);
    this.host.setStat("Chain", "x" + (1 + Math.floor(this.chain / 5)));
    this.host.setStat("Lives", this.lives);
    this.host.setStat("Level", this.level);
  };

  // --- Game loop ---------------------------------------------------------
  Chomp.prototype.start = function () {
    this._sync();
    var self = this;
    // ROM frame is ~0.15s; ghosts move every ghost_rate ticks, dots decay every
    // decay_rate ticks. Keep that cadence but a touch snappier for touch play.
    var TICK_MS = 150;
    this.lastT = performance.now();
    var loop = function (t) {
      if (self.stopped) { return; }
      if (!self.sized && !self.resize()) {
        self.lastT = t;
        self.raf = requestAnimationFrame(loop);
        return;
      }
      var dt = t - self.lastT;
      self.lastT = t;

      if (!self.over) {
        self.acc += dt;
        while (self.acc >= TICK_MS) {
          self.acc -= TICK_MS;
          self._step();
        }
      }
      if (self.flash) { self.flash.ttl -= dt; if (self.flash.ttl <= 0) { self.flash = null; } }
      if (self.shudder > 0) { self.shudder -= dt; if (self.shudder < 0) { self.shudder = 0; } }

      self._draw();

      if (self.over && !self.announced) {
        self.announced = true;
        self.host.gameOver({
          title: "Game Over",
          lines: [
            "Score " + self.score,
            "Best chain " + self.bestChain,
            "Level " + self.level
          ]
        });
      }
      self.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  };

  // One game tick: ghost cadence + decay cadence, level-scaled like the ROM.
  Chomp.prototype._step = function () {
    if (this.over) { return; }
    this.tick++;

    // Ghost speed: faster at higher levels, slower while scared.
    var ghostRate = 4 - Math.floor(this.level / 3);
    if (ghostRate < 2) { ghostRate = 2; }
    if (this.scared > 0) { ghostRate += 2; }
    if (this.tick % ghostRate === 0) { this._moveGhosts(); }

    // Dot decay: faster at higher levels.
    var decayRate = 60 - this.level * 5;
    if (decayRate < 20) { decayRate = 20; }
    if (this.tick % decayRate === 0) { this._decay(); }

    if (this.scared > 0) { this.scared--; }
    this._sync();
  };

  Chomp.prototype.stop = function () {
    this.stopped = true;
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; }
  };

  // --- Self-healing resize (copied from Chromafall) ----------------------
  Chomp.prototype.resize = function () {
    var surface = this.canvas.parentElement;
    if (!surface) { return false; }
    var maxW = surface.clientWidth;
    var maxH = surface.clientHeight;
    if (maxW < 20 || maxH < 20) { return false; }
    var cell = Math.floor(Math.min(maxW / MAP_W, maxH / MAP_H));
    if (cell < 6) { cell = 6; }
    this.cell = cell;
    var dpr = window.devicePixelRatio || 1;
    this.canvas.width = MAP_W * cell * dpr;
    this.canvas.height = MAP_H * cell * dpr;
    this.canvas.style.width = (MAP_W * cell) + "px";
    this.canvas.style.height = (MAP_H * cell) + "px";
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.sized = true;
    return true;
  };

  // --- Render ------------------------------------------------------------
  Chomp.prototype._draw = function () {
    var ctx = this.ctx, c = this.cell;
    var ox = 0, oy = 0;
    if (this.shudder > 0) {
      ox = (Math.random() - 0.5) * 4;
      oy = (Math.random() - 0.5) * 4;
    }
    ctx.save();
    ctx.translate(ox, oy);

    // Background.
    ctx.fillStyle = "#050510";
    ctx.fillRect(-4, -4, MAP_W * c + 8, MAP_H * c + 8);

    for (var y = 0; y < MAP_H; y++) {
      for (var x = 0; x < MAP_W; x++) {
        var idx = y * MAP_W + x;
        if (this.wall[idx] === 1) {
          ctx.fillStyle = "#1f2b6b";
          ctx.fillRect(x * c + 0.5, y * c + 0.5, c - 1, c - 1);
          ctx.fillStyle = "#3348c0";
          ctx.fillRect(x * c + 2, y * c + 2, c - 4, c - 4);
          continue;
        }
        var t = this.token[idx];
        if (t === 0) { continue; }
        this._dot(x, y, t);
      }
    }

    // Ghosts.
    for (var i = 0; i < NUM_GHOSTS; i++) {
      this._ghost(this.gx[i], this.gy[i]);
    }

    // Player.
    this._player();

    // Flash wash (eat / ghost-kill / chain-break).
    if (this.flash) {
      var alpha = Math.max(0, this.flash.ttl / 220) * 0.35;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = this.flash.color;
      ctx.fillRect(0, 0, MAP_W * c, MAP_H * c);
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  };

  Chomp.prototype._dot = function (x, y, t) {
    var ctx = this.ctx, c = this.cell;
    var cx = x * c + c / 2, cy = y * c + c / 2;
    if (t === 9) {
      // Power pellet: pulsing bright orb.
      var pulse = (this.tick % 4) < 2 ? 1 : 0.6;
      ctx.globalAlpha = pulse;
      ctx.fillStyle = "#e9c3ff";
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(3, c * 0.34), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      return;
    }
    // Thermal dots: hot=red-bright, warm=amber, cold=dim grey.
    var color, r;
    if (t === 3) { color = "#ff4d4d"; r = c * 0.20; }
    else if (t === 2) { color = "#ffcc33"; r = c * 0.16; }
    else { color = "#667080"; r = c * 0.12; }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1.5, r), 0, Math.PI * 2);
    ctx.fill();
  };

  Chomp.prototype._player = function () {
    var ctx = this.ctx, c = this.cell;
    var cx = this.px * c + c / 2, cy = this.py * c + c / 2;
    var rad = c * 0.42;
    // Mouth animates open/closed and faces the travel direction.
    var open = (this.tick % 2 === 0) ? 0.28 : 0.05;
    var facing = { right: 0, down: 0.5, left: 1, up: 1.5 }[this.pdir] || 0;
    var a0 = (facing + open) * Math.PI;
    var a1 = (facing + 2 - open) * Math.PI;
    ctx.fillStyle = this.scared > 0 ? "#3ad1ff" : "#ffe14d";
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, rad, a0, a1);
    ctx.closePath();
    ctx.fill();
  };

  Chomp.prototype._ghost = function (gx, gy) {
    var ctx = this.ctx, c = this.cell;
    var x = gx * c, y = gy * c;
    var r = c * 0.4;
    var cx = x + c / 2, cy = y + c / 2;
    ctx.fillStyle = this.scared > 0 ? "#2a44cc" : "#ff3b3b";
    // Dome.
    ctx.beginPath();
    ctx.arc(cx, cy - c * 0.05, r, Math.PI, 0);
    // Skirt.
    var by = cy + r * 0.9;
    ctx.lineTo(cx + r, by);
    var feet = 4;
    for (var f = 0; f < feet; f++) {
      var fx = cx + r - (2 * r) * ((f + 0.5) / feet);
      ctx.lineTo(fx, by - (f % 2 === 0 ? r * 0.28 : 0));
    }
    ctx.lineTo(cx - r, by);
    ctx.closePath();
    ctx.fill();
    // Eyes.
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(cx - r * 0.35, cy - c * 0.08, r * 0.22, 0, Math.PI * 2);
    ctx.arc(cx + r * 0.35, cy - c * 0.08, r * 0.22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = this.scared > 0 ? "#aaccff" : "#1a2b8a";
    ctx.beginPath();
    ctx.arc(cx - r * 0.30, cy - c * 0.06, r * 0.10, 0, Math.PI * 2);
    ctx.arc(cx + r * 0.40, cy - c * 0.06, r * 0.10, 0, Math.PI * 2);
    ctx.fill();
  };
})();
