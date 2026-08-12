# 10 — Dual-mode real-binary regression smoke

**What to build:** plugin hook-dispatch 真实 smoke——默认纯契约测试（便宜，CI 常跑）+ opt-in 真 CLI 运行（隔离 fixture + timeout + 断言机器可读 JSON 契约）。现有测试全 in-memory，抓不到 wiring 层 bug。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 默认纯契约断言（reducer/state 层）
- [ ] opt-in 真实 hook 派发 smoke（隔离 fixture + timeout）
- [ ] 断言 hook 信封 JSON（触发一次、schema 正确、env 正确）
- [ ] 文档：如何运行 opt-in smoke
