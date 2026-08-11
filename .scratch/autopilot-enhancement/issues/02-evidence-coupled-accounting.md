# 02 — Evidence-coupled 记账 + receipt 排序

**What to build:** 只有验证通过（evidence passed）的轮才计入 progress；证据→记账严格排序（先验证后记账，fail-closed：validator 抛错/garbage → inconclusive → repair_required）。现在每轮都计 continuation、验证失败也算——修掉。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 未验证的轮不计入 progress（验证失败轮不算"推进"）
- [ ] evidence→记账排序纪律（先验证结果后记账）
- [ ] validator fail-closed：抛错/垃圾输出 → inconclusive → repair（不静默通过）
- [ ] no-progress 检测与新记账语义一致（不误报/不漏报）
- [ ] 契约测试：验证失败轮不推进、fail-closed 分支
