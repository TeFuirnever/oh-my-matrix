/* hero.js — (1) rough.js self-draws a wobbly frame around the terminal,
   (2) types an honest autopilot session into the terminal body, looping.
   Terminal copy is code-like English in both languages (it's a terminal). */
(function () {
  "use strict";
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var LINES = [
    ["prompt", "$ omm autopilot \"refactor auth module\""],
    ["arrow", "→ goal parsed · projection active"],
    ["arrow", "→ exploring codebase (2 agents)"],
    ["arrow", "→ drafting .prose workflow · evidence gate ON"],
    ["arrow", "→ fan-out: 3 subagents · permission-policy: 0 blocked"],
    ["ok", "✓ verified · 0 unverified claims"]
  ];

  var body, caret;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function mkLine(cls) {
    var d = document.createElement("div");
    d.className = "line " + cls;
    return d;
  }
  function mkCaret() {
    var c = document.createElement("span");
    c.className = "caret";
    c.textContent = "_";
    return c;
  }

  // ---- rough.js frame -------------------------------------------------
  function drawFrame() {
    var svg = document.getElementById("terminal-frame");
    var term = document.querySelector && document.querySelector(".terminal");
    if (!svg || !term || !window.rough) return;
    var r = term.getBoundingClientRect();
    var tw = Math.round(r.width), th = Math.round(r.height);
    if (tw < 20 || th < 20) return;
    // CSS insets the svg by -16 → svg = term + 32w / +32h; draw a marker outline ~8px outside the box
    svg.setAttribute("width", tw + 32);
    svg.setAttribute("height", th + 32);
    svg.setAttribute("viewBox", "0 0 " + (tw + 32) + " " + (th + 32));
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var rc = rough.svg(svg);
    svg.appendChild(rc.rectangle(8, 8, tw + 16, th + 16, {
      stroke: "#2d3436", strokeWidth: 3.2, roughness: 2.8, bowing: 2
    }));
    // a second loose inner scribble for marker depth
    svg.appendChild(rc.rectangle(14, 14, tw + 4, th + 4, {
      stroke: "#3498db", strokeWidth: 1.6, roughness: 3.2, bowing: 2.4, fillOpacity: 0
    }));
  }

  // ---- typing ---------------------------------------------------------
  function renderStatic() {
    body.innerHTML = "";
    LINES.forEach(function (l) { body.appendChild(mkLine(l[0])); body.lastChild.textContent = l[1]; });
  }

  async function typeLine(lineEl, text, perChar) {
    for (var i = 1; i <= text.length; i++) {
      lineEl.textContent = text.slice(0, i);
      lineEl.appendChild(caret);
      await sleep(perChar);
    }
  }

  async function typeSession() {
    body.innerHTML = "";
    caret = mkCaret();
    for (var i = 0; i < LINES.length; i++) {
      var cls = LINES[i][0], txt = LINES[i][1];
      var line = mkLine(cls);
      body.appendChild(line);
      line.appendChild(caret);
      if (i === 0) {
        await typeLine(line, txt, 34);          // typed command
      } else {
        await sleep(240);                       // streaming output
        line.textContent = txt;
        line.appendChild(caret);
        await sleep(70);
      }
    }
    if (caret && caret.parentNode) caret.parentNode.removeChild(caret);
  }

  async function loop() {
    drawFrame();
    if (reduced) { renderStatic(); return; }
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await typeSession();
      await sleep(3200);
    }
  }

  function init() {
    body = document.getElementById("terminal-body");
    if (!body) return;
    // clear noscript fallback before animating
    body.innerHTML = "";
    loop();

    var t = null;
    window.addEventListener("resize", function () {
      clearTimeout(t);
      t = setTimeout(drawFrame, 150);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
