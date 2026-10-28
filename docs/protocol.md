# Agent bridge 协议（v1）

## 连接与授权

浏览器插件在用户点击授权后调用：

```http
POST /api/browser/sessions
Origin: http://127.0.0.1:19400
Content-Type: application/json

{"traceName":"demo.json","traceFingerprint":"<64 hex>","parserVersion":"perfetto-<commit>"}
```

服务返回 `session`、`token`、`request_url`。浏览器随后以同一 Origin 建立 `/ws/browser?session=...&token=...` WebSocket。token 至少 256 位随机数。

agent 不直接访问浏览器 WebSocket，而调用本地 HTTP 包装：

```http
POST /api/agent/request
Authorization: Bearer <token>
Content-Type: application/json
```

服务仅接受 loopback Host；浏览器写授权和 WebSocket 必须同源，agent 若带 Origin 也必须为允许的本地 Origin。服务不返回 CORS 授权头。

## 请求与响应

```json
{
  "id": "req-1",
  "kind": "selection.set",
  "session": "<session>",
  "expected_version": 12,
  "args": {"slice_ids": ["12345"]}
}
```

- `id`：1–128 个字母、数字、下划线、点、冒号或连字符；同会话进行中的请求不能重用。
- `kind`：下表中的固定命令，没有 `eval`。
- `session`：必须与 Authorization token 绑定的 session 一致。
- `expected_version`：写操作可选的乐观并发版本。页面实际状态不等于它时返回 `VERSION_CONFLICT`。
- `args`：对象。时间戳及其他 Trace Processor int64 使用十进制字符串。

成功：

```json
{"id":"req-1","ok":true,"version":13,"result":{"slice_ids":["12345"]}}
```

失败：

```json
{
  "id":"req-1",
  "ok":false,
  "version":13,
  "error":{"code":"SLICE_NOT_FOUND","message":"Slice 12345 does not exist or has no visible track"}
}
```

HTTP 非 200 不代表响应不是结构化 JSON；agent 应同时检查 `ok` 和 `error.code`。断连、关闭标签页或切换 trace 后，旧 token 返回 `UNAUTHORIZED`，进行中的请求以会话错误结束。

## 命令

| `kind` | 主要参数 | 作用 |
|---|---|---|
| `state.get` | 无 | trace 身份、视口、focus、area、tracks、notes、布局、版本和连接状态 |
| `state.export` | 无 | 带格式版本的独立视图文档 |
| `state.import` | `view` | 校验并恢复兼容视图 |
| `query` | `sql`, `max_rows`, `timeout_ms` | 在当前标签页 Engine 中执行只读 SQL |
| `query.cancel` | `query_id` | 上游支持时请求取消；不支持时明确报错 |
| `selection.set` | `slice_ids` | 选择一个存在的 slice；不存在时 `SLICE_NOT_FOUND` |
| `selection.clear` | 无 | 清除选择 |
| `viewport.set` | `start`, `end` | 设置可见时间窗 |
| `viewport.center` | `start`, 可选 `end` | 居中但不强制缩放 |
| `viewport.zoomToSelection` | 无 | 缩放到当前选择 |
| `area.set` | `start`, `end`, `track_uris` | 创建区域选择 |
| `area.clear` | 无 | 清除当前区域选择 |
| `layout.set` | `track_uri`, `action` | `collapse` / `expand` / `pin` / `unpin`；也可传稳定节点 ID |
| `layout.reset` | 无 | 恢复本次 trace 初始折叠和置顶布局 |
| `notes.add` | `start`, 可选 `end`, `text`, `color`, 可选 `id` | 新建单点或区间 note |
| `notes.update` | `id` 和待修改字段 | 修改已存在 note |
| `notes.remove` | `id` | 删除已存在 note |
| `history.list` | 无 | 最多 200 条操作日志，不含完整 SQL 或 trace 内容 |
| `history.undo` | 无 | 撤销最近一次 agent 写操作 |

## SQL 限制

- 仅单条 `SELECT` 或 `WITH`；不允许 `INCLUDE PERFETTO MODULE`。
- 禁止多语句、`PRAGMA`、附件、扩展加载、文件读写和写入/DDL 关键字。字符串和注释中的文本不会误判为语句。
- 默认 `max_rows=100`，允许 1–1000；适配层把查询包装为 `LIMIT max_rows+1`，用于正确返回 `truncated`。
- 查询结果最大 1 MiB。`LONG` / bigint 转十进制字符串；BLOB 转为 `{"$bytes":"<hex>"}`；REAL 保持 JSON number。
- 默认超时 30 秒，可配置 100–60000 毫秒。单 session 同时最多一个查询。
- 当前官方浏览器 Engine 无公开取消 API 时，超时返回 `QUERY_TIMEOUT`，`cancel_requested=false`、`underlying_query_may_run=true`。迟到结果被丢弃；底层查询未结束前新查询返回 `QUERY_BUSY`。

## 视图文档

顶层字段：

```json
{
  "format": "perfetto-local-collab-view",
  "format_version": 1,
  "trace": {
    "fingerprint": "<sha256 of original trace>",
    "name": "demo.json",
    "parser_version": "perfetto-<commit>"
  },
  "viewport": {"start": "1", "end": "2"},
  "focus": null,
  "area": null,
  "notes": [],
  "layout": [],
  "tracks": []
}
```

恢复时要求 `fingerprint` 和 `parser_version` 同时匹配。视图最大 2 MiB，最多 5000 条 notes 和 10000 条布局记录。引用不存在的 track、note 或非法 focus 会明确失败。

## 版本与撤销

- 用户和 agent 操作读取同一个官方页面状态；没有影子视图。
- 写操作前重新捕获状态，避免轮询间隙覆盖刚刚发生的用户编辑。
- 异步视图操作执行期间，其他视图状态读写返回 `VIEW_BUSY`；等待完成后重新 `state.get` 再重试。只读 trace SQL 和 `history.list` 不受此限制。
- 每个实际改变视图的 agent 写操作增加版本，并保存操作前快照。
- 只有最新 agent 操作且版本仍等于操作后的版本时可撤销。
- 后续用户编辑使版本变化，`history.undo` 返回 `UNDO_CONFLICT`，不会用旧快照覆盖新编辑。
- 撤销只影响视图，不修改 trace。

## 传输限制

HTTP agent 请求和 WebSocket 消息最大 3 MiB，视图文档最大 2 MiB；agent 客户端接受最大 4 MiB 响应。授权后浏览器若 60 秒内未连接，session 过期；服务最多保留 32 个待授权/已授权 session。
