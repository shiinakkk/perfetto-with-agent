# Perfetto 本地 Agent 协作版

在用户电脑上运行官方 Perfetto 前端。用户通过文件选择器打开 trace，并显式授权后，agent 可以查询当前 Trace Processor、选中 kernel、调整时间窗与区域、修改 track 布局、添加 notes，并保存或撤销视图操作。

**原始 trace 不上传、不修改。标注和布局保存在独立的视图 JSON 中。**

## 组成

- `upstream/perfetto-ui-v59.1.zip`：官方 v59.1 完整 UI 发布制品，含前端、WASM、worker 和字体。
- `ui-dist/`：由官方发布包和本地 `collab.js` 生成的运行目录。
- `plugin/`：协作控制器与适配层；`runtime_adapter.ts` 用于官方发布 UI，`perfetto_adapter.ts` 用于可选源码构建。
- `server/`：仅监听 loopback 的静态服务、授权会话和 WebSocket → HTTP 转发。
- `bin/`、`agent.ps1`：agent HTTP 客户端与命令行。
- `examples/`：可重复生成的 GPU kernel trace 和最长 kernel 演示。
- `test/`：协议、安全、视图、查询、撤销和真实浏览器测试。

官方发布前端在同一页面通过其生产版本已有的 `window.app` 调试入口暴露真实 `App` / `Trace` 公共接口；本地 `collab.js` 直接操作这些对象，不使用 iframe，也不连接或修改线上 `ui.perfetto.dev`。

## 环境

- Windows / PowerShell。
- Node.js 22 或更高版本；打包官方发布 UI 时还需要 Python 3 用于解压 ZIP。
- 默认运行不需要 WSL、C++ 编译器或完整上游源码。
- 正式查看流程不需要原有内网服务，也不访问 `ui.perfetto.dev`。

## 构建本地发布包

```powershell
npm install
npm run build
```

如果官方 ZIP 不在本地，脚本会从 Perfetto v59.1 GitHub Release 下载 `perfetto-ui.zip`，记录并校验 SHA-256，然后解包、构建 `collab.js` 并生成 `ui-dist/`。网络下载只发生在构建阶段；运行阶段的页面、WASM、字体和 worker 都由本地 Node 服务提供。

`build-manifest.json` 和 `ui-dist/collab-manifest.json` 记录官方版本、制品哈希、解析器版本及输出目录。

### 可选：从源码编译

`upstream/perfetto/` 保留了本次检查的官方源码。`npm run build:source` 会执行官方 `tools/install-build-deps --ui` 和 `ui/build`，并安装源码形态的协作插件。上游明确不支持原生 Windows UI 构建时会尝试 `Ubuntu-22.04` WSL2。该路径需要完整 C++/Emscripten 依赖，不是标准运行的前提。

固定源码参考提交为 `15010533b275181cdd593027908704369d1c99b5`；默认发布运行时的解析器版本为 `perfetto-v59.1-official-ui`。

## 启动

```powershell
.\start.ps1
```

默认地址：[http://127.0.0.1:19400/](http://127.0.0.1:19400/)。可通过 `.\start.ps1 -Port 19401` 改端口，服务仍只允许回环地址。

也可以直接运行：

```powershell
npm start
# 或指定已构建 UI
node server/index.mjs --ui <dist目录> --port 19400
```

## 授权 agent

1. 在本地页面中通过文件选择器打开 trace，等待官方解析完成。
2. 右上角 **Agent collaboration** 面板会分块计算原文件 SHA-256。此过程只读本地文件，用于视图兼容性检查。
3. 点击 **Allow agent to connect**。
4. 点击 **Copy PowerShell environment**，在运行 agent 的 PowerShell 中粘贴；或下载 `perfetto-agent-connection.json`。
5. 验证连接：

```powershell
.\agent.ps1 state --pretty
# 使用连接文件时：
.\agent.ps1 state --connection .\perfetto-agent-connection.json --pretty
```

连接文件含秘密令牌，应当作为凭证保管。令牌不写入服务器日志或磁盘数据库。

点击 **Disconnect agent**、关闭标签页、卸载或切换 trace 后，session 和令牌立即失效。多个标签页必须分别授权。

## 可重复演示

生成示例 trace（仓库中也已包含生成结果）：

```powershell
node examples/create-demo-trace.mjs
```

在 Perfetto 中打开 `examples/demo-trace.json` 并授权 agent，然后运行：

```powershell
npm run demo
```

演示会：

1. 用当前标签页的 Trace Processor 查询最长 kernel；
2. 按 slice ID 选中它；
3. 缩放到 kernel 附近；
4. 添加区间 note；
5. 输出最终状态版本。

每一步写操作都携带最新 `expected_version`。如果用户中途修改了视图，流程会冲突停止，而不是覆盖用户操作。最后一步可用以下命令撤销：

```powershell
.\agent.ps1 undo
```

### 真实 B300 目标定位

打开一份 B300 rank trace 并授权后运行：

```powershell
npm run demo:b300
```

脚本分别定位 `fused_rope`（本次 B300 trace 中的 mRoPE 实现，并非字面量 `mRoPE`）、`sparse_mla` 和 `deep_ep::legacy::internode_ll::combine`，逐个选中、缩放并添加区间标注。返回结果包含完整 kernel 名称、slice ID、Trace Processor track ID、时间戳和时长。

## 常用 agent 命令

```powershell
# SQL；int64 在 JSON 中使用十进制字符串
.\agent.ps1 query --sql "SELECT id, ts, dur, name FROM slice ORDER BY dur DESC LIMIT 10" --pretty

# 一个焦点 slice；多个 track 的时间范围请使用 area
.\agent.ps1 select --slice-id 123 --expected-version 4
.\agent.ps1 zoom-selection
.\agent.ps1 zoom --start 1000000 --end 2000000

# track URI 从 state 返回的 tracks 列表获取
.\agent.ps1 area --start 1000000 --end 2000000 --track "<track-uri>"
.\agent.ps1 layout --track "<track-uri-or-node-id>" --pin
.\agent.ps1 layout --track "<track-uri-or-node-id>" --collapse

.\agent.ps1 note --start 1000000 --end 2000000 --text "检查这段 kernel"
.\agent.ps1 update-note --id "<note-id>" --text "更新说明"
.\agent.ps1 remove-note --id "<note-id>"

.\agent.ps1 export --output view.json
.\agent.ps1 import --input view.json
.\agent.ps1 logs --pretty
.\agent.ps1 undo
```

完整协议见 [docs/protocol.md](docs/protocol.md)。

## 视图保存与恢复

- 面板 **Save / Restore saved** 使用浏览器 localStorage，键包含 trace 内容指纹和 Perfetto 发布/解析器版本。Save 是独立手动保存点；Restore 优先恢复它，否则恢复自动保存的最新视图，后续 agent 操作不会覆盖手动保存点。
- **Export JSON / Import JSON** 保存时间窗、focus、area、notes 和布局。
- 文件或解析器版本不匹配时拒绝恢复，不盲用旧 slice ID。
- agent 的最近一次有效写操作可一步撤销；之后若用户又编辑了视图，撤销返回 `UNDO_CONFLICT`。
- `caption` 没有混入持久 `notes`。

## 安全边界

- 默认仅绑定 `127.0.0.1`，同时校验 Host、Origin 和至少 256 位随机会话令牌。
- 只允许结构化 JSON 命令，不支持任意 JavaScript `eval`，不提供 shell 或磁盘文件读取 API。
- SQL 仅允许单条 `SELECT` / `WITH` 只读查询；禁止模块加载、文件函数、写入语法和多语句。
- 查询默认最多 100 行，硬上限 1000 行；响应约 1 MiB；请求体、WebSocket 消息和超时均有限制。
- 同一会话同时只执行一个查询。日志不记录完整 SQL 或 trace 内容。
- 构建时先写入 `analyticsEnable=false`，官方代码因此选用无网络的 `NullAnalytics`；响应 CSP 还禁止非回环连接、远程脚本和外部 iframe 嵌入。
- 服务和静态资源均在本地；验收时仍需以浏览器实际网络请求为准。

## 当前版本边界

- 第一版使用浏览器内 Trace Processor WASM；查询需要标签页和 trace 保持加载，没有无浏览器原生后端。
- 官方前端只有一个焦点 slice；`selection.set` 一次接受一个 ID。
- notes 是时间线上的单点或区间标注；当前上游公开模型不提供 track-bound note。
- 当前上游浏览器 Engine 没有公开取消 API。超时会丢弃迟到结果，并明确报告底层查询可能仍执行；旧查询未结束前，同会话新查询返回 `QUERY_BUSY`。
- 不加载官方 ExtensionServers 的旧版远程 userscript，也不启用远程扩展服务器；核心时间线、详情和 SQL 功能保留。
- 不实现多 trace 联动、多人实时协作、远程上传、云端持久化或原始 trace 编辑。

## 测试

```powershell
npm test
npm audit
# 构建并启动后：
npm run test:e2e
```

实际构建和验收证据见 [docs/acceptance.md](docs/acceptance.md)，上游 API 适配点见 [docs/upstream-adapter.md](docs/upstream-adapter.md)。
