# 上游版本与适配记录

## 默认运行版本：官方 v59.1 发布 UI

标准运行不依赖本机重新编译 C++。`scripts/package-ui.mjs` 使用 Perfetto GitHub Release 的完整制品：

```text
https://github.com/google/perfetto/releases/download/v59.1/perfetto-ui.zip
```

ZIP 包含官方前端、Trace Processor WASM、worker、字体和其他静态资源。脚本校验 `upstream-revision.json` 中的 `release_ui_sha256`，解包后将本地 `collab.js` 和 `collab-bootstrap.js` 注入 HTML，输出到 `ui-dist/`。运行时不访问 `ui.perfetto.dev`。

默认视图 `parser_version` 为 `perfetto-v59.1-official-ui`。更换官方 UI 版本时必须更新该值，旧视图会因解析器不匹配而拒绝直接恢复。

## 发布版运行时接入

官方生产前端在 `ui/src/frontend/debug.ts` 中注册 `window.app = AppImpl.instance`，不是仅测试构建才有。`plugin/runtime.ts` 使用这个既有入口得到真实 `App` / `Trace`，没有跨域 iframe，也没有另建影子视图。

- `runtime_adapter.ts`：官方发布制品的适配器。
- `collab-bootstrap.js`：在官方初始化前写入 `analyticsEnable=false`，使上游选择无网络的 `NullAnalytics`。
- `collab.js`：由 `runtime.ts` 及其依赖打包的本地 IIFE，无远程模块。
- 通过 `onTraceReady` 与官方 `waitForPerfettoIdle()` 确认加载完成；通过 `trace.trash` 在卸载时断开授权。
- `time` 在运行时是 bigint 品牌类型，可直接传 bigint；`HighPrecisionTimeSpan.fromTime` 通过当前 `visibleWindow.constructor` 调用，是发布版需要复核的运行时依赖。

## 使用的公开 API

| 能力 | 上游公开接口 |
|---|---|
| 原始文件指纹 | `Trace.getTraceFile()` |
| SQL | `Trace.engine.query()`、`QueryResult.columns()`、`iter().get()` |
| 时间窗 | `Trace.timeline.visibleWindow`、`setVisibleWindow()`、`panIntoView()`、`panSpanIntoView()` |
| slice 解析与选择 | `SelectionManager.resolveSqlEvents('slice', ...)`、`selectTrackEvent()` |
| 区域 | `SelectionManager.selectArea()`、`clearSelection()` |
| 缩放到选择 | `SelectionManager.scrollToSelection('focus')` |
| track 列表 | `TrackManager.getTrack()`、`Workspace.flatTracksOrdered` |
| 折叠、展开、置顶 | `TrackNode.collapse()/expand()/pin()/unpin()` |
| 新建、更新 notes | `NoteManager.addNote()/addSpanNote()/getNote()` |
| 生命周期 | `Trace.onTraceReady`、`Trace.trash.use()/defer()` |

SQL `LONG` 由上游解码为 bigint，桥接层转换成十进制字符串，避免 Number 精度损失。Engine 没有公开取消 API，因此适配器不伪造取消成功。

## 集中封装的内部依赖

以下能力在当前公开接口中不完整，只在两个适配文件中集中处理：

1. `NoteManagerImpl.notes`：列举 notes，用于视图保存和统一状态读取。
2. `NoteManagerImpl.removeNote(id)`：删除 note。
3. `SelectionManagerImpl.selectNote({id})`：恢复 note focus。
4. 发布版的 `HighPrecisionTimeSpan` 构造器从现有对象取得。

对应上游实现位于 `ui/src/core/note_manager.ts`、`ui/src/core/selection_manager.ts` 和 `ui/src/base/high_precision_time_span.ts`。升级时必须检查这些成员是否仍存在及语义是否改变。

## ID 与持久化

- `Track.tags.trackIds` 是 Trace Processor track ID，按字符串导出。
- `TrackNode.uri` 是前端 track 内容 URI。
- `TrackNode.id` 只在当前 UI 会话唯一，可用于即时操作，不能盲用于重载后的持久引用。
- 无 URI 分组在保存布局时使用 `group:<父子索引路径>`，并同时记录 `fullPath` 供检查；相同 trace 与解析器版本下才允许恢复。
- 一个 stream 可导入成多个前端 track，不能假定 `track_id` 与 URI 一一对应，也不能用显示层叠代替时间重叠分析。

## 本地安全边界

默认发布包在官方初始化前关闭 analytics。Node 服务另外返回严格 CSP：

- 脚本、样式、字体、图片和 worker 仅允许本地及必要的 blob/data。
- `connect-src` 只允许本地页面和回环 HTTP/WebSocket，不允许远程 HTTPS。
- `X-Frame-Options: DENY` 与 `frame-ancestors 'none'` 防止外部页面嵌入后诱导授权。

官方在 localhost 默认绕过 Service Worker 注册。最终以实际网络验收为准，不仅依据配置推断离线。

## 可选源码构建

保留一份官方源码用于 API 核对和可选 `npm run build:source`：

- 参考提交：`15010533b275181cdd593027908704369d1c99b5`。
- 源码 ZIP SHA-256：`1afbcb01d9413d4689b38ad6c117c45b201b9ba34f55c28bd7801e193e7f70e2`。
- 源码插件位于 `ui/src/plugins/dev.perfetto.LocalCollab/`，上游通过 `import.meta.glob` 自动发现；`scripts/build.mjs` 只修改激活点和本地安全策略。

本次环境验证到：上游明确拒绝原生 Windows UI 构建；WSL2 路径在执行完整依赖安装时因 `chromium.googlesource.com` 连接超时中断。因此默认交付使用官方 v59.1 完整发布制品，不声称本次已从源码完成 WASM 编译。详细记录见 `docs/acceptance.md`。
