# M4 — 安装期两个 bug

**仓**: MatrixAssistant（主进程 / 资源层）
**阻塞**: 无 —— 可立即开工
**设计文档**: §5.12 必做 3

---

## Bug 1 — `plugin-registry.json` 里有 Windows 临时路径

`resources/plugins/plugin-registry.json:6`：

```json
"downloadUrl": "file:///C:/temp/autopilot-3.0.3.tgz"
```

两个问题叠加：**Windows 临时路径进了发布资源**，且版本停在 3.0.3（引擎已 3.1.0）。同文件 `:16` 的 test-matrix-plugin 同病。

三处读该文件：
- `electron/utils/host-plugin-loader.ts`
- `electron/utils/plugin-registry-reader.ts`
- `electron/utils/plugin-installer/registry-resolver.ts`

## Bug 2 — `getTgzPath()` 版本错配

`electron/main/ipc/autopilot-handlers.ts:76`。解包目录是 3.1.0，而 tgz 只有 `autopilot-3.0.3.tgz`。

两个修法二选一：
- 补 3.1.0 的 tgz；
- 让 `autopilot:install` 直接从已解包目录装（更省，不用维护 tgz）。

## 根因是同一个

两个 bug 都是**引擎产物 vendor 流程缺自动化**的症状——见 X1。M4 修当前的错配，X1 防它复发。**只做 M4 的话，下一轮引擎改动会原样重现。**

## 验收

- [ ] `plugin-registry.json` 无绝对路径、无平台特定路径
- [ ] 版本号与 `resources/claw-plugin/autopilot/package.json` 一致
- [ ] 三处读取方在新配置下正常工作
- [ ] 安装流程实测通过（不是只看代码）
