/*
 * CHAIN CHOMP -- browser port of roms/chain-chomp.sh
 *
 * A dino grazing a provenance chain. Faithful to the ROM:
 *   - The same 21x11 maze template (# wall, . fern, o roar pellet).
 *   - Thermal fern decay: ferns have heat hot(3) -> warm(2) -> cold(1) -> gone(0)
 *     and cool on a timer; hotter ferns are worth more, so you naturally graze the
 *     hottest first. Rendered by color/brightness.
 *   - Provenance CHAIN: consecutive grazes build a multiplier (1 + chain/5). A
 *     raptor hit BREAKS the chain, costs a life, and can end the game.
 *   - Raptors chase (greedy pursuit, prefer larger-distance axis, 30% jitter),
 *     flip and flee while a roar pellet is active, and speed up per level.
 *
 * The ROM writes cue-mem tokens (chain heat, raptor_kill, chain_break) as a side
 * effect on the token pool. The public arcade has no substrate to write to, so
 * that provenance identity is kept as FEEL -- the on-screen Chain multiplier,
 * the raptor-eat flash, and the chain-break shudder -- not as a pool mutation.
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
  var RAPTOR_STARTS = [[5, 5], [15, 5]];
  var NUM_RAPTORS = 2;

  // Token codes on a cell: 0 none, 1 cold, 2 warm, 3 hot, 9 roar pellet.
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
    this.pdir = "left";           // facing, for the dino head
    this.rx = []; this.ry = [];
    this.scared = 0;              // ticks of roar mode remaining

    this.score = 0;
    this.chain = 0;
    this.bestChain = 0;
    this.lives = 3;
    this.level = 1;
    this.tick = 0;
    this.over = false;

    this.flash = null;            // { color, ttl } graze/raptor-kill wash
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
    this.rx = []; this.ry = [];
    for (var i = 0; i < NUM_RAPTORS; i++) {
      this.rx[i] = RAPTOR_STARTS[i][0];
      this.ry[i] = RAPTOR_STARTS[i][1];
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

    // Provenance-as-feel: brief wash tinted by the fern's heat.
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
    for (var i = 0; i < NUM_RAPTORS; i++) {
      if (this.rx[i] === this.px && this.ry[i] === this.py) {
        this._resolveRaptor(i);
        if (this.over) { return; }
      }
    }
  };

  // Shared raptor/player overlap resolution (ROM has this in two places).
  Chomp.prototype._resolveRaptor = function (i) {
    if (this.scared > 0) {
      this.score += 200 * this.level;
      this.rx[i] = 10; this.ry[i] = 5;
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

  // --- Raptor AI (greedy pursuit, ROM-faithful) --------------------------
  Chomp.prototype._moveRaptors = function () {
    for (var i = 0; i < NUM_RAPTORS; i++) {
      var rx = this.rx[i], ry = this.ry[i];

      var dx = 0, dy = 0;
      if (this.px > rx) { dx = 1; } else if (this.px < rx) { dx = -1; }
      if (this.py > ry) { dy = 1; } else if (this.py < ry) { dy = -1; }

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
        if (dx !== 0 && this._canMove(rx + dx, ry)) { this.rx[i] = rx + dx; moved = true; }
        else if (dy !== 0 && this._canMove(rx, ry + dy)) { this.ry[i] = ry + dy; moved = true; }
      } else {
        if (dy !== 0 && this._canMove(rx, ry + dy)) { this.ry[i] = ry + dy; moved = true; }
        else if (dx !== 0 && this._canMove(rx + dx, ry)) { this.rx[i] = rx + dx; moved = true; }
      }

      // If stuck, try any open direction.
      if (!moved) {
        var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        var start = Math.floor(Math.random() * 4);
        for (var d = 0; d < 4; d++) {
          var pick = (start + d) % 4;
          var tdx = dirs[pick][0], tdy = dirs[pick][1];
          if (this._canMove(rx + tdx, ry + tdy)) {
            this.rx[i] = rx + tdx; this.ry[i] = ry + tdy;
            break;
          }
        }
      }

      // Collision after the raptor moved.
      if (this.rx[i] === this.px && this.ry[i] === this.py) {
        this._resolveRaptor(i);
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
    // ROM frame is ~0.15s; raptors move every raptor_rate ticks, ferns decay every
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

  // One game tick: raptor cadence + decay cadence, level-scaled like the ROM.
  Chomp.prototype._step = function () {
    if (this.over) { return; }
    this.tick++;

    // Raptor speed: faster at higher levels, slower while scared.
    var raptorRate = 4 - Math.floor(this.level / 3);
    if (raptorRate < 2) { raptorRate = 2; }
    if (this.scared > 0) { raptorRate += 2; }
    if (this.tick % raptorRate === 0) { this._moveRaptors(); }

    // Fern decay: faster at higher levels.
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
        this._fern(x, y, t);
      }
    }

    // Raptors.
    for (var i = 0; i < NUM_RAPTORS; i++) {
      this._raptor(this.rx[i], this.ry[i]);
    }

    // Player.
    this._player();

    // Flash wash (graze / raptor-kill / chain-break).
    if (this.flash) {
      var alpha = Math.max(0, this.flash.ttl / 220) * 0.35;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = this.flash.color;
      ctx.fillRect(0, 0, MAP_W * c, MAP_H * c);
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  };

  Chomp.prototype._fern = function (x, y, t) {
    var ctx = this.ctx, c = this.cell;
    var cx = x * c + c / 2, cy = y * c + c / 2;
    if (t === 9) {
      // Roar pellet: pulsing bright orb.
      var pulse = (this.tick % 4) < 2 ? 1 : 0.6;
      ctx.globalAlpha = pulse;
      ctx.fillStyle = "#e9c3ff";
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(3, c * 0.34), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      return;
    }
    // Thermal ferns: hot=bright, warm=amber, cold=dim. A tiny sprig, not a dot.
    var color, r;
    if (t === 3) { color = "#49e06b"; r = c * 0.22; }
    else if (t === 2) { color = "#a7d24d"; r = c * 0.18; }
    else { color = "#5a6b55"; r = c * 0.14; }
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, c * 0.06);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx, cy + r);
    ctx.lineTo(cx, cy - r);           // stem
    ctx.moveTo(cx, cy - r * 0.2);
    ctx.lineTo(cx - r * 0.8, cy - r * 0.7);  // left frond
    ctx.moveTo(cx, cy - r * 0.2);
    ctx.lineTo(cx + r * 0.8, cy - r * 0.7);  // right frond
    ctx.stroke();
  };

  Chomp.prototype._player = function () {
    var cx = this.px * this.cell + this.cell / 2;
    var cy = this.py * this.cell + this.cell / 2;
    var face = (this.pdir === "left") ? -1 : 1;   // up/down keep last horizontal
    var chomp = (this.tick % 2 === 0);            // jaw opens on alternate ticks
    var ctx = this.ctx;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(face, 1);
    this._dino(this.cell, this.scared > 0 ? "#3ad1ff" : "#57d957", chomp);
    ctx.restore();
  };

  // A chunky green T-rex facing right, drawn centered on the origin.
  Chomp.prototype._dino = function (s, color, chomp) {
    var ctx = this.ctx;
    ctx.fillStyle = color;

    // Tail.
    ctx.beginPath();
    ctx.moveTo(-0.46 * s, -0.02 * s);
    ctx.quadraticCurveTo(-0.28 * s, -0.12 * s, -0.10 * s, 0.00 * s);
    ctx.quadraticCurveTo(-0.28 * s, 0.12 * s, -0.46 * s, 0.08 * s);
    ctx.closePath();
    ctx.fill();

    // Body.
    ctx.beginPath();
    ctx.ellipse(-0.04 * s, 0.05 * s, 0.28 * s, 0.24 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    // Legs.
    ctx.fillRect(-0.14 * s, 0.20 * s, 0.11 * s, 0.22 * s);
    ctx.fillRect(0.05 * s, 0.20 * s, 0.11 * s, 0.22 * s);

    // Back spikes.
    ctx.beginPath();
    var sx = [-0.24, -0.09, 0.06];
    for (var k = 0; k < sx.length; k++) {
      var bx = sx[k] * s;
      ctx.moveTo(bx, -0.16 * s);
      ctx.lineTo(bx + 0.05 * s, -0.30 * s);
      ctx.lineTo(bx + 0.10 * s, -0.16 * s);
    }
    ctx.fill();

    // Neck + head.
    ctx.beginPath();
    ctx.ellipse(0.28 * s, -0.16 * s, 0.17 * s, 0.15 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0.04 * s, -0.08 * s);
    ctx.lineTo(0.30 * s, -0.24 * s);
    ctx.lineTo(0.32 * s, 0.02 * s);
    ctx.lineTo(0.08 * s, 0.10 * s);
    ctx.closePath();
    ctx.fill();

    // Upper snout.
    ctx.beginPath();
    ctx.moveTo(0.32 * s, -0.24 * s);
    ctx.lineTo(0.49 * s, -0.20 * s);
    ctx.lineTo(0.49 * s, -0.12 * s);
    ctx.lineTo(0.34 * s, -0.10 * s);
    ctx.closePath();
    ctx.fill();

    // Lower jaw (drops when chomping).
    var jaw = chomp ? 0.11 * s : 0.0;
    ctx.beginPath();
    ctx.moveTo(0.32 * s, -0.05 * s);
    ctx.lineTo(0.49 * s, -0.04 * s + jaw);
    ctx.lineTo(0.41 * s, 0.03 * s + jaw);
    ctx.lineTo(0.30 * s, 0.00 * s);
    ctx.closePath();
    ctx.fill();

    // Eye.
    ctx.fillStyle = "#06240a";
    ctx.beginPath();
    ctx.arc(0.33 * s, -0.19 * s, 0.038 * s, 0, Math.PI * 2);
    ctx.fill();
  };

  // A lean red raptor, drawn centered on its cell, facing the player.
  Chomp.prototype._raptor = function (rx, ry) {
    var ctx = this.ctx, c = this.cell;
    var cx = rx * c + c / 2, cy = ry * c + c / 2;
    var face = (this.px < rx) ? -1 : 1;
    var body = this.scared > 0 ? "#2a44cc" : "#ff3b3b";
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(face, 1);
    ctx.fillStyle = body;

    // Tail (raised, sweeping up and back).
    ctx.beginPath();
    ctx.moveTo(-0.12 * c, 0.02 * c);
    ctx.quadraticCurveTo(-0.44 * c, -0.08 * c, -0.46 * c, -0.30 * c);
    ctx.quadraticCurveTo(-0.32 * c, -0.12 * c, -0.08 * c, 0.12 * c);
    ctx.closePath();
    ctx.fill();

    // Body (leaning forward).
    ctx.beginPath();
    ctx.ellipse(-0.02 * c, 0.03 * c, 0.24 * c, 0.19 * c, -0.3, 0, Math.PI * 2);
    ctx.fill();

    // Hind leg with raised sickle claw.
    ctx.beginPath();
    ctx.moveTo(-0.10 * c, 0.06 * c);
    ctx.lineTo(0.03 * c, 0.06 * c);
    ctx.lineTo(0.07 * c, 0.30 * c);
    ctx.lineTo(-0.01 * c, 0.42 * c);
    ctx.lineTo(0.15 * c, 0.42 * c);
    ctx.lineTo(0.04 * c, 0.26 * c);
    ctx.closePath();
    ctx.fill();

    // Neck + head (up and forward).
    ctx.beginPath();
    ctx.moveTo(0.10 * c, -0.04 * c);
    ctx.lineTo(0.26 * c, -0.26 * c);
    ctx.lineTo(0.37 * c, -0.23 * c);
    ctx.lineTo(0.24 * c, 0.03 * c);
    ctx.closePath();
    ctx.fill();

    // Snout (pointed upper jaw).
    ctx.beginPath();
    ctx.moveTo(0.31 * c, -0.26 * c);
    ctx.lineTo(0.49 * c, -0.19 * c);
    ctx.lineTo(0.34 * c, -0.13 * c);
    ctx.closePath();
    ctx.fill();

    // Lower jaw (open, gaping).
    ctx.beginPath();
    ctx.moveTo(0.31 * c, -0.11 * c);
    ctx.lineTo(0.45 * c, -0.13 * c);
    ctx.lineTo(0.33 * c, -0.03 * c);
    ctx.closePath();
    ctx.fill();

    // Tiny arm.
    ctx.beginPath();
    ctx.moveTo(0.13 * c, 0.02 * c);
    ctx.lineTo(0.23 * c, 0.11 * c);
    ctx.lineTo(0.16 * c, 0.12 * c);
    ctx.closePath();
    ctx.fill();

    // Eye (yellow hunting, pale while fleeing) + pupil.
    ctx.fillStyle = this.scared > 0 ? "#bcd3ff" : "#ffd23b";
    ctx.beginPath();
    ctx.arc(0.32 * c, -0.20 * c, 0.048 * c, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#200000";
    ctx.beginPath();
    ctx.arc(0.34 * c, -0.20 * c, 0.022 * c, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  };
})();
