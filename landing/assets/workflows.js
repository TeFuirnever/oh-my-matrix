/* workflows.js — draws a hand-drawn .prose fan-out onto #flow-canvas with rough.js.
   Layout (logical 860×360): task → 3 subagents → 3 verify → evidence gate → merged output.
   Animates stage-by-stage when scrolled into view; draws all at once under reduced motion. */
(function () {
  "use strict";
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var canvas, ctx, rc;
  var LW = 860, LH = 360;

  var C = {
    task: { s: "#cbd5e1", f: "rgba(203,213,225,.07)" },
    sub: { s: "#2ecc71", f: "rgba(46,204,113,.10)" },
    verify: { s: "#22d3ee", f: "rgba(34,211,238,.10)" },
    gate: { s: "#e6a23c", f: "rgba(230,162,60,.13)" },
    out: { s: "#60a5fa", f: "rgba(96,165,250,.13)" },
    line: "#7c8aa0"
  };

  var TASK = { x: 20, y: 140, w: 120, h: 80 };
  var SUB_W = 120, SUB_H = 54;
  var VER_W = 120, VER_H = 54;
  var ROWS = [60, 153, 246];
  var GATE = { x: 590, y: 140, w: 110, h: 80 };
  var OUT = { x: 730, y: 140, w: 120, h: 80 };
  var MIDY = 180;

  function boxOpts(c) {
    return { stroke: c.s, strokeWidth: 2.4, roughness: 1.7, bowing: 1.2, fill: c.f, fillStyle: "hachure", hachureGap: 6, fillWeight: 1 };
  }
  function box(b, c, label, sub) {
    rc.rectangle(b.x, b.y, b.w, b.h, boxOpts(c));
    ctx.fillStyle = "#e8eef6"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    if (sub) {
      ctx.font = "700 14px 'JetBrains Mono', monospace";
      ctx.fillText(label, cx, cy - 8);
      ctx.fillStyle = "#9aa6b8";
      ctx.font = "400 12px 'JetBrains Mono', monospace";
      ctx.fillText(sub, cx, cy + 11);
    } else {
      ctx.font = "600 15px 'JetBrains Mono', monospace";
      ctx.fillText(label, cx, cy);
    }
  }
  function conn(x1, y1, x2, y2) {
    rc.line(x1, y1, x2, y2, { stroke: C.line, strokeWidth: 1.5, roughness: 1.3, bowing: 1 });
  }

  function setup() {
    canvas = document.getElementById("flow-canvas");
    if (!canvas) return false;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = LW * dpr;
    canvas.height = LH * dpr;
    ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    if (!window.rough) return false;
    rc = rough.canvas(canvas);
    return true;
  }

  var stages = [
    function () { box(TASK, C.task, "task"); },
    function () {
      ROWS.forEach(function (y) { conn(TASK.x + TASK.w, MIDY, 210, y + SUB_H / 2); });
      ROWS.forEach(function (y, i) { box({ x: 210, y: y, w: SUB_W, h: SUB_H }, C.sub, "agent", String(i + 1)); });
    },
    function () {
      ROWS.forEach(function (y) { conn(210 + SUB_W, y + SUB_H / 2, 400, y + VER_H / 2); });
      ROWS.forEach(function (y) { box({ x: 400, y: y, w: VER_W, h: VER_H }, C.verify, "verify"); });
    },
    function () {
      ROWS.forEach(function (y) { conn(400 + VER_W, y + VER_H / 2, GATE.x, MIDY); });
      box(GATE, C.gate, "evidence", "gate");
    },
    function () {
      conn(GATE.x + GATE.w, MIDY, OUT.x, MIDY);
      box(OUT, C.out, "merged", "✓ verified");
    }
  ];

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function play() {
    if (!setup()) return;
    ctx.clearRect(0, 0, LW, LH);
    if (reduced) { stages.forEach(function (s) { s(); }); return; }
    for (var i = 0; i < stages.length; i++) {
      stages[i]();
      await sleep(320);
    }
  }

  function init() {
    var target = document.getElementById("flow-canvas");
    if (!target) return;
    if (!("IntersectionObserver" in window)) { play(); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { play(); io.disconnect(); }
      });
    }, { threshold: 0.25 });
    io.observe(target);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
