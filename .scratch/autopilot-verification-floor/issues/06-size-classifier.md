# 06 — size-classifier 任务形状路由（选做）

**What to build:** 初始轮按任务形状（涉及文件量 × 是否引入新依赖/契约 × 设计模糊度）分类为 trivial/small/standard/large，路由到对应的思考强度路径。分类在首轮发生一次，用户可覆盖。**不是规划阶段**——只是对既有强度路由的输入增强。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 首轮完成一次任务形状分类，存为状态
- [ ] 四档映射到既有思考强度路径（trivial→低强度 … large→高强度）
- [ ] 用户可覆盖分类结果
- [ ] 无分类信息时回退现有默认（fail-open）
