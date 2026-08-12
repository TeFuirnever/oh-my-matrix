# 11 — size-classifier 任务形状路由（遗留 T06，选做）

**What to build:** 首轮按任务形状（涉及文件量 × 新依赖/契约 × 设计模糊度）分类 trivial/small/standard/large，路由思考强度。**不是规划阶段**——只是对既有强度路由的输入增强。

**Blocked by:** None — can start immediately

**Status:** ✅ 已实施（master commit 22c9e23 `feat(autopilot): task-size classifier routes effort by goal shape`）— autopilot 4.3.0 发布

## 已交付（22c9e23，主 session）
- 任务形状分类（trivial/small/standard/large）路由思考强度
- 四档映射既有 effort/model 路径
- autopilot 4.3.0 changeset + 发布

- [x] 首轮完成一次任务形状分类，存为状态
- [x] 四档映射到既有思考强度路径（trivial→低 … large→高）
- [x] 用户可覆盖分类结果
- [x] 无分类信息时回退现有默认（fail-open）
