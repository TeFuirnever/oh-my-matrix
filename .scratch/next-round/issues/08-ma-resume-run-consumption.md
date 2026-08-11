# 08 — MA 宿主 resume_run 消费（P3-29 全闭合）

**What to build:** 宿主驱动改为显式调用 `autopilot.resume_run`（E13 RPC）消费跨轮续行——gateway restart 不再靠 flag 隐式 re-broadcast，P3-29 double-spend 全链路闭合。

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] 宿主恢复 mid-cross-turn run 时调用 resume_run（一次）
- [ ] 幂等（重复调用不双 kick——gateway resume 已清 needsCrossTurnResume）
- [ ] 回归：重启窗口无双 spend

## 参考
E13/P3-29 文档（index.ts resume_run 注释）；omm-implementation-status E13 行。
