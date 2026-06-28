/* i18n — zh (default, matches inline HTML) / en toggle, persisted in localStorage.
   apply() preserves child elements: when a [data-i18n] node has element children,
   it rewrites only the leading text node so nested <code>/<a>/<span> survive. */
(function () {
  "use strict";
  var STORE = "omm-lang";

  var i18n = {
    zh: {
      "nav.abilities": "能力", "nav.demo": "演示", "nav.boundary": "边界", "nav.roadmap": "路线图",

      "hero.badge": "WIP · 当前无公开 release · 源码/测试/ADR 公开",
      "hero.title.a": "把 OpenClaw 变成",
      "hero.title.b": "可持续工作的 ",
      "hero.title.c": "agent runtime",
      "hero.tagline": "Autopilot 连续执行 · Dynamic Workflows 多 agent 编排 · Permission Policy 运行时安全边界。面向 OpenClaw 宿主与集成者。",
      "hero.cta.start": "开始使用 →",
      "hero.cta.repo": "查看源码",
      "hero.meta": "根仓库 v0.7.2 · 三块可测试能力",

      "abilities.eyebrow": "三块能力",
      "abilities.title.a": "模块化的 ",
      "abilities.title.b": "agent runtime stack",
      "abilities.lede": "不是终端用户 CLI,也不是独立 SaaS。给 OpenClaw 宿主加载、打包、验证的三块可测试能力。",
      "abilities.c1.tag": "CONTINUOUS EXECUTION", "abilities.c1.title": "Autopilot",
      "abilities.c1.body": "长程任务连续执行,带目标、重试、stall 检测、证据门和面向宿主 UI 的状态投影。",
      "abilities.c1.l1": "目标驱动循环 · 重试 + stall 检测",
      "abilities.c1.l2": "证据门 (evidence gate) 前置验证",
      "abilities.c1.l3": "projection:compact status / evidence / retry",
      "abilities.c1.l4": "WORKFLOW.md front matter 配置",
      "abilities.c2.tag": "MULTI-AGENT ORCHESTRATION", "abilities.c2.title": "Dynamic Workflows",
      "abilities.c2.body": "AI 根据自然语言生成 .prose 编排程序,经 OpenProse 执行。",
      "abilities.c2.l1": "fan-out-reduce · pipeline",
      "abilities.c2.l2": "adversarial-verify · loop-until-dry",
      "abilities.c2.l3": "routing · tournament",
      "abilities.c2.l4": "generate-and-filter · duel-loop (8 模式)",
      "abilities.c3.tag": "RUNTIME BOUNDARY", "abilities.c3.title": "Permission Policy",
      "abilities.c3.body": "autopilot 与 workflow subagent 共享的安全层。defaultDeny,分类 + 审计持久化。",
      "abilities.c3.l1": "拦截 destructive git / workspace cleanup",
      "abilities.c3.l2": "credential / system write 拦截",
      "abilities.c3.l3": "shell & process substitution 拦截",
      "abilities.c3.l4": "wrapper exec (npx / pnpm exec)",

      "demo.eyebrow": "实时流程",
      "demo.title.a": "一个任务,", "demo.title.b": "fan-out", "demo.title.c": " 成并行 agent",
      "demo.lede": "Dynamic Workflows 把任务拆成并行 subagent,经过 adversarial verification 和 evidence 门,合并成可信结果。下面是 .prose 执行的手绘示意。",
      "demo.legend.sub": "subagent", "demo.legend.verify": "adversarial verify",
      "demo.legend.gate": "evidence gate", "demo.legend.merged": "merged output",

      "boundary.eyebrow": "运行时边界",
      "boundary.title.a": "subagent 没有免费通行证。",
      "boundary.lede": "这些是当前会被拦下的真实操作。分类、决策、审计持久化。",
      "boundary.shield": "defaultDeny",
      "boundary.b3": "credential / system 写入",
      "boundary.b4": "shell 与 process substitution",
      "boundary.b5": "wrapper exec",
      "boundary.note.t": "已知限制,诚实公开:",
      "boundary.note.b": "tokenize-based,不是完整 shell parser。redirect 写文件、未知非 shell 框架工具、引号内 operator 误伤,记录在 ",
      "boundary.note.c": "。不藏。",

      "honest.eyebrow": "诚实的开源面",
      "honest.title.a": "不包装未验证的 ", "honest.title.b": "release / star / adoption",
      "honest.lede": "当前是 WIP。下面这些是真的且公开,那些还在内部 —— 都摆出来。",
      "honest.ok.t": "公开且真实",
      "honest.ok.l1": "源码", "honest.ok.l1b": "packages/autopilot 等托管源码",
      "honest.ok.l2": "测试", "honest.ok.l2b": "可复现",
      "honest.ok.l3": "ADR", "honest.ok.l3b": "docs/adr 架构决策记录",
      "honest.ok.l4": "已知限制", "honest.ok.l4b": "docs/fixes 公开",
      "honest.ok.l5": "CHANGELOG", "honest.ok.l5b": "变更可追溯",
      "honest.wip.t": "仍是 WIP / 内部",
      "honest.wip.l1": "@openclaw/*", "honest.wip.l1b": "private workspace packages",
      "honest.wip.l2": "host deploy", "honest.wip.l2b": "需内部 refresh / vendoring",
      "honest.wip.l3": "workflow 可视化", "honest.wip.l3b": "宿主 UI 契约未定",
      "honest.wip.l4": "公开发布清单", "honest.wip.l4b": "哪些 package 可发布,待明确",

      "roadmap.eyebrow": "路线图",
      "roadmap.title.a": "近期 ", "roadmap.title.b": "优先级",
      "roadmap.lede": "把内部能力变成可公开、可复现、可验证的工程交付。",
      "roadmap.r1.t": "Autopilot 一等公开叙事", "roadmap.r1.b": "README / docs / website 与源码能力对齐。",
      "roadmap.r2.t": "Host deploy 可复现化", "roadmap.r2.b": "refresh / pack / install / smoke check 记录成可执行 runbook。",
      "roadmap.r3.t": "Workflow visual observability", "roadmap.r3.b": ".prose fan-out / evidence / blocked calls 宿主 UI 可视化契约。",
      "roadmap.r4.t": "Permission policy hardening", "roadmap.r4.b": "从 tokenize-based 向更完整的 shell model 演进。",
      "roadmap.r5.t": "Release readiness", "roadmap.r5.b": "明确哪些 packages 可以公开发布,哪些仍是 host-internal。",

      "cta.title": "WIP。欢迎一起把它做扎实。",
      "cta.body": "从文档、测试、host integration runbook 和安全用例开始 —— 每一块都能上手。",
      "cta.b1": "GitHub 仓库 →", "cta.b2": "Getting Started", "cta.b3": "贡献指南",

      "footer.tag": "OpenClaw Agent Runtime Stack",
      "footer.sub": "面向 OpenClaw 宿主与集成者 · 不是终端 CLI,不是 SaaS",
      "footer.github": "GitHub", "footer.docs": "Docs",
      "footer.made": "hand-drawn with Kalam + rough.js"
    },

    en: {
      "nav.abilities": "Abilities", "nav.demo": "Demo", "nav.boundary": "Boundary", "nav.roadmap": "Roadmap",

      "hero.badge": "WIP · no public release yet · source / tests / ADRs open",
      "hero.title.a": "Turn OpenClaw into an",
      "hero.title.b": "agent runtime that ",
      "hero.title.c": "actually ships",
      "hero.tagline": "Autopilot continuous execution · Dynamic Workflows multi-agent orchestration · Permission Policy runtime boundary. Built for OpenClaw hosts & integrators.",
      "hero.cta.start": "Get started →",
      "hero.cta.repo": "View source",
      "hero.meta": "root repo v0.7.2 · three testable capabilities",

      "abilities.eyebrow": "Three capabilities",
      "abilities.title.a": "A modular ",
      "abilities.title.b": "agent runtime stack",
      "abilities.lede": "Not an end-user CLI, not a standalone SaaS. Three testable capabilities for OpenClaw hosts to load, package, and verify.",
      "abilities.c1.tag": "CONTINUOUS EXECUTION", "abilities.c1.title": "Autopilot",
      "abilities.c1.body": "Long-horizon continuous execution with goals, retries, stall detection, evidence gates, and host-UI state projection.",
      "abilities.c1.l1": "Goal-driven loop · retry + stall detection",
      "abilities.c1.l2": "Evidence gate up-front verification",
      "abilities.c1.l3": "projection: compact status / evidence / retry",
      "abilities.c1.l4": "WORKFLOW.md front-matter config",
      "abilities.c2.tag": "MULTI-AGENT ORCHESTRATION", "abilities.c2.title": "Dynamic Workflows",
      "abilities.c2.body": "AI generates .prose orchestration programs from natural language, executed by OpenProse.",
      "abilities.c2.l1": "fan-out-reduce · pipeline",
      "abilities.c2.l2": "adversarial-verify · loop-until-dry",
      "abilities.c2.l3": "routing · tournament",
      "abilities.c2.l4": "generate-and-filter · duel-loop (8 patterns)",
      "abilities.c3.tag": "RUNTIME BOUNDARY", "abilities.c3.title": "Permission Policy",
      "abilities.c3.body": "The shared safety layer for autopilot & workflow subagents. defaultDeny, with classification + audit persistence.",
      "abilities.c3.l1": "blocks destructive git / workspace cleanup",
      "abilities.c3.l2": "credential / system write blocked",
      "abilities.c3.l3": "shell & process substitution blocked",
      "abilities.c3.l4": "wrapper exec (npx / pnpm exec)",

      "demo.eyebrow": "Live flow",
      "demo.title.a": "One task, ", "demo.title.b": "fan-out", "demo.title.c": " into parallel agents",
      "demo.lede": "Dynamic Workflows splits a task into parallel subagents, runs adversarial verification and an evidence gate, and merges a trustworthy result. Below: a hand-drawn .prose run.",
      "demo.legend.sub": "subagent", "demo.legend.verify": "adversarial verify",
      "demo.legend.gate": "evidence gate", "demo.legend.merged": "merged output",

      "boundary.eyebrow": "Runtime boundary",
      "boundary.title.a": "subagents get no free pass.",
      "boundary.lede": "These are the operations currently blocked. Classification, decision, and audit are persisted.",
      "boundary.shield": "defaultDeny",
      "boundary.b3": "credential / system write",
      "boundary.b4": "shell & process substitution",
      "boundary.b5": "wrapper exec",
      "boundary.note.t": "Known limitations, openly stated:",
      "boundary.note.b": "tokenize-based, not a full shell parser. Redirect file-writes, unknown non-shell tools, and in-quote operator false-positives are documented in ",
      "boundary.note.c": ". Nothing hidden.",

      "honest.eyebrow": "Honest open source",
      "honest.title.a": "No faked ", "honest.title.b": "release / star / adoption",
      "honest.lede": "Currently WIP. Here's what's real and open, and what's still internal — all on the table.",
      "honest.ok.t": "Real & open",
      "honest.ok.l1": "Source", "honest.ok.l1b": "hosted source in packages/autopilot etc.",
      "honest.ok.l2": "Tests", "honest.ok.l2b": "reproducible via pnpm test",
      "honest.ok.l3": "ADRs", "honest.ok.l3b": "architecture decisions in docs/adr",
      "honest.ok.l4": "Known limits", "honest.ok.l4b": "open in docs/fixes",
      "honest.ok.l5": "CHANGELOG", "honest.ok.l5b": "traceable changes",
      "honest.wip.t": "Still WIP / internal",
      "honest.wip.l1": "@openclaw/*", "honest.wip.l1b": "private workspace packages",
      "honest.wip.l2": "host deploy", "honest.wip.l2b": "needs internal refresh / vendoring",
      "honest.wip.l3": "workflow viz", "honest.wip.l3b": "host-UI contract undefined",
      "honest.wip.l4": "release list", "honest.wip.l4b": "which packages ship, TBD",

      "roadmap.eyebrow": "Roadmap",
      "roadmap.title.a": "Near-term ", "roadmap.title.b": "priorities",
      "roadmap.lede": "Turning internal capability into public, reproducible, verifiable engineering.",
      "roadmap.r1.t": "Autopilot first-class narrative", "roadmap.r1.b": "Align README / docs / website with source capabilities.",
      "roadmap.r2.t": "Reproducible host deploy", "roadmap.r2.b": "refresh / pack / install / smoke-check as an executable runbook.",
      "roadmap.r3.t": "Workflow visual observability", "roadmap.r3.b": "Host-UI viz contract for .prose fan-out / evidence / blocked calls.",
      "roadmap.r4.t": "Permission policy hardening", "roadmap.r4.b": "Evolve from tokenize-based toward a fuller shell model.",
      "roadmap.r5.t": "Release readiness", "roadmap.r5.b": "Clarify which packages can publish, which stay host-internal.",

      "cta.title": "It's WIP. Come help make it solid.",
      "cta.body": "Start from docs, tests, host-integration runbooks, and security use cases — every piece is hands-on.",
      "cta.b1": "GitHub repo →", "cta.b2": "Getting Started", "cta.b3": "Contributing",

      "footer.tag": "OpenClaw Agent Runtime Stack",
      "footer.sub": "For OpenClaw hosts & integrators · not a CLI, not a SaaS",
      "footer.github": "GitHub", "footer.docs": "Docs",
      "footer.made": "hand-drawn with Kalam + rough.js"
    }
  };

  function apply(lang) {
    if (!i18n[lang]) lang = "zh";
    var dict = i18n[lang];
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var key = el.getAttribute("data-i18n");
      if (!(key in dict)) return;
      var val = dict[key];
      if (el.childElementCount === 0) {
        el.textContent = val;
      } else {
        var firstText = null;
        for (var i = 0; i < el.childNodes.length; i++) {
          if (el.childNodes[i].nodeType === 3) { firstText = el.childNodes[i]; break; }
        }
        if (firstText) firstText.nodeValue = val;
        else el.insertBefore(document.createTextNode(val), el.firstChild);
      }
    });
    document.querySelectorAll('.lang-toggle button').forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-lang") === lang));
    });
  }

  function setLang(lang) {
    try { localStorage.setItem(STORE, lang); } catch (e) {}
    apply(lang);
  }

  function init() {
    var lang = "zh";
    try { lang = localStorage.getItem(STORE) || "zh"; } catch (e) {}
    apply(lang);
    document.querySelectorAll('.lang-toggle button').forEach(function (b) {
      b.addEventListener("click", function () { setLang(b.getAttribute("data-lang")); });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
  window.__ommI18n = { apply: apply, setLang: setLang };
})();
