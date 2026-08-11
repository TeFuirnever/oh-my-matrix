# 11 — size-classifier 任务形状路由（遗留 T06，选做）

**What to build:** 首轮按任务形状（涉及文件量 × 新依赖/契约 × 设计模糊度）分类 trivial/small/standard/large，路由思考强度。**不是规划阶段**——只是对既有强度路由的输入增强。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 首轮完成一次任务形状分类，存为状态
- [ ] 四档映射到既有思考强度路径（trivial→低 … large→高）
- [ ] 用户可覆盖分类结果
- [ ] 无分类信息时回退现有默认（fail-open）
