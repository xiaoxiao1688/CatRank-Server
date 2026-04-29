# Cat Game Backend Redesign

## 目标

这个仓库不再做“前端报最终分数，后端做弱校验”的方案，直接重设计为一套可信后端：

- 前端只能创建会话、上报事件、请求结算
- 最终分数只由后端计算
- 排行榜只接受服务端结算结果
- 会话有明确状态流和重复提交防护

这次任务的核心不是做页面，而是做一套有后端价值的小游戏结算系统。

## 产品定义

项目名称：
`cat-game-backend`

一句话定义：
一个为猫咪小游戏提供会话管理、事件接收、服务端结算和排行榜查询的轻量后端服务。

## 一期范围

一期只做后端，不做复杂前端。

必须完成：

- 创建游戏会话
- 启动会话
- 接收游戏事件
- 关闭并结算会话
- 排行榜查询
- 排行榜分页
- 重复提交防护
- 会话超时清理
- 基础风控校验

明确不做：

- 用户登录
- 数据库接入
- WebSocket
- 多人对战
- 管理后台
- 实时反作弊

## 核心设计

### 1. 会话状态机

每个 session 必须有明确状态：

- `created`
- `playing`
- `finished`
- `closed`
- `expired`

允许流转：

- `created -> playing`
- `playing -> finished`
- `created -> closed`
- `playing -> closed`
- `created/playing -> expired`

禁止：

- `finished -> playing`
- `finished -> finished`
- `closed -> playing`
- `expired -> finish`

### 2. 事件驱动结算

前端不再提交 `score`。

前端只上报事件，例如：

- `fish_caught`
- `golden_fish_caught`
- `bomb_hit`
- `enemy_defeated`
- `power_up_used`
- `skill_used`

后端保存事件流，再根据规则计算：

- 基础得分
- 惩罚
- 连击加成
- 道具加成
- 最终得分

### 3. 服务端可信排行榜

排行榜记录来源只能是：

- 已完成结算的 session
- 每个 session 只能入榜一次
- 记录中必须保留结算快照

排行榜字段：

- `id`
- `sessionId`
- `playerName`
- `score`
- `createdAt`
- `summary`

## 快速开始

### 安装依赖

```bash
npm install
```

### 启动服务

```bash
npm start
```

### 开发模式（自动重启）

```bash
npm run dev
```

### 运行检查

```bash
npm run check
```

服务默认运行在 `http://127.0.0.1:4321`

## API 接口

### 健康检查

#### `GET /healthz`

检查服务是否正常运行。

响应：

```json
{
  "ok": true
}
```

### 会话管理

#### `POST /api/sessions`

创建新的游戏会话。

请求（可选）：

```json
{
  "playerName": "Guest Cat"
}
```

- `playerName`: 玩家名称，可选，最长 20 字符，默认 "Guest Cat"

响应：

```json
{
  "ok": true,
  "sessionId": "sess_1710000000000_abc123",
  "state": "created",
  "createdAt": "2026-04-27T00:00:00.000Z"
}
```

#### `GET /api/sessions/:sessionId`

查询会话详情。

响应：

```json
{
  "ok": true,
  "session": {
    "id": "sess_xxx",
    "playerName": "Guest Cat",
    "state": "playing",
    "createdAt": "2026-04-27T00:00:00.000Z",
    "startedAt": "2026-04-27T00:00:05.000Z",
    "finishedAt": null,
    "closedAt": null,
    "expiredAt": null,
    "submittedToLeaderboard": false,
    "events": [],
    "result": null
  }
}
```

#### `POST /api/sessions/:sessionId/start`

启动会话，状态从 `created` 变为 `playing`。

响应：

```json
{
  "ok": true,
  "sessionId": "sess_xxx",
  "state": "playing",
  "startedAt": "2026-04-27T00:00:00.000Z"
}
```

#### `POST /api/sessions/:sessionId/events`

上报游戏事件。只能在 `playing` 状态下调用。

请求：

```json
{
  "type": "fish_caught",
  "occurredAt": 1710000000000,
  "payload": {
    "combo": 3
  }
}
```

- `type`: 事件类型，必须是以下之一：
  - `fish_caught`
  - `golden_fish_caught`
  - `bomb_hit`
  - `enemy_defeated`
  - `power_up_used`
  - `skill_used`
- `occurredAt`: 事件发生时间戳（毫秒），可选，默认当前时间
- `payload`: 额外数据，可选

响应：

```json
{
  "ok": true,
  "accepted": true,
  "eventId": "evt_1710000000000_abc123"
}
```

#### `POST /api/sessions/:sessionId/finish`

结束会话并结算，状态从 `playing` 变为 `finished`，结果自动提交到排行榜。

注意：每个 session 只能调用一次 `finish`，重复调用会返回 409 错误。

响应：

```json
{
  "ok": true,
  "sessionId": "sess_xxx",
  "state": "finished",
  "result": {
    "score": 180,
    "summary": {
      "fishCaught": 10,
      "goldenFishCaught": 2,
      "bombHit": 1,
      "enemyDefeated": 3,
      "powerUpsUsed": 0,
      "skillsUsed": 0,
      "maxCombo": 5,
      "totalEvents": 16
    },
    "breakdown": {
      "baseScore": 175,
      "comboBonus": 5
    }
  }
}
```

#### `POST /api/sessions/:sessionId/close`

主动关闭会话（不入榜），状态从 `created` 或 `playing` 变为 `closed`。

响应：

```json
{
  "ok": true,
  "sessionId": "sess_xxx",
  "state": "closed",
  "closedAt": "2026-04-27T00:00:00.000Z"
}
```

#### `POST /api/sessions/cleanup-expired`

手动触发过期会话清理。服务也会自动每分钟执行一次清理。

- `created` 或 `playing` 状态的会话，如果超过 `SESSION_TTL_MS`（默认 15 分钟）没有活动，会被标记为 `expired`
- `finished` 或 `closed` 状态的会话不会过期

响应：

```json
{
  "ok": true,
  "expiredCount": 3
}
```

- `expiredCount`: 本次清理中被标记为过期的会话数量

### 排行榜

#### `GET /api/leaderboard?page=1&pageSize=20`

分页查询排行榜。按分数降序，分数相同则按时间升序。

参数：
- `page`: 页码，可选，默认 1
- `pageSize`: 每页数量，可选，默认 20，最大 100

响应：

```json
{
  "ok": true,
  "page": 1,
  "pageSize": 20,
  "total": 135,
  "items": [
    {
      "rank": 1,
      "sessionId": "sess_xxx",
      "playerName": "Guest Cat",
      "score": 180,
      "createdAt": "2026-04-27T00:00:00.000Z",
      "summary": {
        "fishCaught": 10,
        "goldenFishCaught": 2,
        "bombHit": 1,
        "enemyDefeated": 3,
        "powerUpsUsed": 0,
        "skillsUsed": 0,
        "maxCombo": 5,
        "totalEvents": 16
      }
    }
  ]
}
```

## 错误响应格式

所有错误响应都遵循统一格式：

### 业务错误（HttpError）

```json
{
  "ok": false,
  "message": "Session not found",
  "details": null
}
```

常见 HTTP 状态码：
- `400`: 请求参数错误
- `404`: 资源不存在（如 session 不存在）
- `409`: 状态冲突（如状态机不允许的操作、重复结算）
- `410`: 资源已过期（如 session 已过期）
- `422`: 无法处理的实体（如事件数量超限、时间戳异常）
- `500`: 服务器内部错误

### 验证错误（ZodError）

当请求参数验证失败时返回：

```json
{
  "ok": false,
  "message": "Validation failed",
  "details": {
    "issues": [
      {
        "field": "playerName",
        "message": "String must contain at most 20 character(s)",
        "code": "too_big"
      }
    ]
  }
}
```

## 数据模型

一期先用文件存储，目录建议：

```text
data/
  sessions/
    sess_xxx.json
  leaderboard.json
  events.log
```

### Session

```json
{
  "id": "sess_xxx",
  "playerName": "Guest Cat",
  "state": "playing",
  "createdAt": "2026-04-27T00:00:00.000Z",
  "startedAt": "2026-04-27T00:00:05.000Z",
  "finishedAt": null,
  "closedAt": null,
  "expiredAt": null,
  "submittedToLeaderboard": false,
  "events": [],
  "result": null
}
```

字段说明：
- `id`: 会话唯一标识
- `playerName`: 玩家名称
- `state`: 当前状态（created/playing/finished/closed/expired）
- `createdAt`: 创建时间
- `startedAt`: 开始时间
- `finishedAt`: 结束时间
- `closedAt`: 关闭时间
- `expiredAt`: 过期时间
- `submittedToLeaderboard`: 是否已提交到排行榜
- `events`: 事件列表
- `result`: 结算结果（state 为 finished 时有值）

### Event

```json
{
  "id": "evt_xxx",
  "type": "fish_caught",
  "occurredAt": 1710000000000,
  "receivedAt": "2026-04-27T00:00:10.000Z",
  "payload": {
    "combo": 3
  }
}
```

## 结算规则建议

先保持简单、稳定、可验证：

- `fish_caught`: +10
- `golden_fish_caught`: +25
- `enemy_defeated`: +15
- `bomb_hit`: -10
- `power_up_used`: 0
- `skill_used`: 0

一期不要做复杂实时组合技，只做：

- 基础事件累计
- 可选最大连击加成
- 得分不小于 0

## 风控要求

必须校验：

- session 必须存在
- 状态必须允许当前操作
- finish 只能调用一次
- closed/expired session 不接受事件
- 单局事件数不能无限增长
- 单位时间内事件频率不能明显异常
- 事件时间不能早于 session.start
- 事件时间不能晚于 finish 太多

## 技术建议

建议栈：

- Node.js
- 原生 `http` 或 `express`
- `zod` 做请求校验
- 文件存储先跑通，再考虑 SQLite

如果只做一期最小实现，优先：

- `Node.js + express + zod`

## 目录建议

```text
src/
  app.js
  server.js
  routes/
    sessions.js
    leaderboard.js
  services/
    session-service.js
    scoring-service.js
    leaderboard-service.js
  repositories/
    session-repo.js
    leaderboard-repo.js
  utils/
    lock.js
    clock.js
    id.js
data/
tests/
```

## 开发顺序

1. 初始化 Node 项目
2. 搭基础 HTTP 服务
3. 实现 session 状态机
4. 实现事件追加接口
5. 实现服务端结算
6. 实现排行榜分页
7. 加锁与原子写入
8. 补测试
9. 写 README 接口说明

## 验收标准

- 前端不能直接提交最终分数
- 同一 session 不能重复结算
- 同一 session 不能重复入榜
- 非法状态流会被拒绝
- 排行榜支持分页
- 重启服务后数据仍可恢复
- 关键流程有测试

## 下一步

下一轮直接开始实现最小后端骨架：

- 初始化 `package.json`
- 建立 `src/server.js`
- 建立 `POST /api/sessions`
- 建立 `POST /api/sessions/:id/start`
- 建立 `POST /api/sessions/:id/events`
- 建立 `POST /api/sessions/:id/finish`
- 建立 `GET /api/leaderboard`

这次不要再回到旧模式，不接受前端直接报分。

## 边界行为说明（9 分支新增）

### 事件风控规则

#### 1. 事件顺序校验

- 新事件的 `occurredAt` 不能比上一个事件早超过 `MAX_EVENT_PAST_SKEW_MS`（默认 5 秒）
- 如果时间倒流过快，返回 **422** 错误

```json
{
  "ok": false,
  "message": "Event timestamp out of order",
  "details": {
    "lastEventAt": 1710000000000,
    "newEventAt": 1709999990000,
    "maxAllowedSkewMs": 5000
  }
}
```

#### 2. 事件频率限制

- **滑动窗口限制**：`EVENT_FREQUENCY_WINDOW_MS`（默认 1 秒）内最多 `MAX_EVENTS_PER_SECOND`（默认 20）个事件
- **最小间隔限制**：两个事件之间间隔不能小于 `MIN_EVENT_INTERVAL_MS`（默认 10 毫秒）
- 超过限制返回 **429** 错误

```json
{
  "ok": false,
  "message": "Too many events",
  "details": {
    "windowMs": 1000,
    "maxEvents": 20,
    "currentCount": 21
  }
}
```

#### 3. Payload 合法性校验

- `payload.combo` 必须是非负整数，且不超过 `MAX_COMBO_VALUE`（默认 100）
- 无效值返回 **422** 错误

```json
{
  "ok": false,
  "message": "Combo value too large",
  "details": {
    "field": "payload.combo",
    "max": 100,
    "actual": 9999
  }
}
```

### 并发与原子性保证

#### 原子结算（防止重复成功）

`finishSession` 整个流程在文件锁内执行：

1. 获取 session 级别的文件锁
2. 锁内重新读取 session（防止使用过期数据）
3. 双重检查 `submittedToLeaderboard` 标志
4. 状态转换 → 计算分数 → 写入排行榜 → 设置标志 → 保存 session
5. 释放锁

**并发行为**：
- 并发 5 次 `finishSession` 调用
- 只有 **1 次** 成功返回 200
- 其余 **4 次** 返回 **409** 错误

#### 事件写入一致性

`addEvent` 写入顺序已调整：

**新顺序**：
1. 写入 event log 到 `events.log`
2. 写入 session 到 JSON 文件

**一致性保证**：
- 如果 log 写入失败，session 不会被修改
- 不会出现"session 已保存但 log 丢失"的情况
- 唯一可能的不一致：log 写入成功但 session 写入失败（log 中有孤儿记录），这是可接受的，因为 session 是真相源

### 状态机边界

| 当前状态 | 允许操作 | 不允许操作 | 不允许时返回 |
|----------|----------|------------|--------------|
| `created` | `start`, `close` | `addEvent`, `finish` | 409 |
| `playing` | `addEvent`, `finish`, `close` | `start` | 409 |
| `finished` | `getSession` | `start`, `addEvent`, `finish`, `close` | 409 |
| `closed` | `getSession` | `start`, `addEvent`, `finish`, `close` | 409 |
| `expired` | `getSession` | 所有操作 | 410 |

### 过期行为

- `created` 或 `playing` 状态的 session 超过 `SESSION_TTL_MS`（默认 15 分钟）会被标记为 `expired`
- 访问过期 session 时，会先保存过期状态，然后返回 **410** 错误
- `finished` 或 `closed` 状态的 session 不会过期

### 文件存储容错

#### JSON 读取容错

- `readJson` 遇到 `SyntaxError`（文件损坏）时返回 `fallbackValue`，而不是抛出异常
- 适用于 `leaderboard.json` 和 `sessions/*.json`

#### Event Log 安全读取

新增 `readLinesSafe` 函数：

```javascript
const result = await readLinesSafe(EVENTS_LOG_FILE);
// {
//   ok: true,
//   validLines: [...],      // 有效的 JSON 行
//   invalidLineNumbers: [5, 8],  // 损坏的行号
//   hasCorruption: true
// }
```

- 自动跳过损坏的行
- 返回损坏行的行号供排查
- 即使部分行损坏，服务仍可正常运行

#### Session 列表安全读取

新增 `listSessionsSafe` 函数：

```javascript
const result = await listSessionsSafe(SESSION_DIR);
// {
//   validSessions: [...],
//   corruptedFiles: [
//     { filePath: '...', isSyntaxError: true }
//   ],
//   hasCorruption: true
// }
```

- 自动跳过损坏的 session JSON 文件
- 返回损坏文件列表供排查

### 可配置参数（环境变量）

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `MAX_COMBO_VALUE` | 100 | combo 最大值 |
| `MAX_EVENTS_PER_SECOND` | 20 | 每秒最大事件数 |
| `MIN_EVENT_INTERVAL_MS` | 10 | 事件最小间隔（毫秒） |
| `EVENT_FREQUENCY_WINDOW_MS` | 1000 | 频率计算窗口（毫秒） |
| `MAX_EVENT_PAST_SKEW_MS` | 5000 | 事件时间倒流最大容忍（毫秒） |
| `MAX_EVENT_FUTURE_SKEW_MS` | 30000 | 事件时间超前最大容忍（毫秒） |
| `MAX_EVENTS_PER_SESSION` | 1000 | 单 session 最大事件数 |
| `SESSION_TTL_MS` | 900000 | session 过期时间（毫秒，默认 15 分钟） |
| `LOCK_TIMEOUT_MS` | 5000 | 锁超时（毫秒） |
| `LOCK_RETRY_MS` | 100 | 锁重试间隔（毫秒） |

## 9 分支与 main 分支差异

### 新增功能

| 功能 | main | 9 分支 |
|------|------|--------|
| 原子结算 | ❌ 有竞态风险 | ✅ 文件锁保护 |
| 事件顺序校验 | ❌ | ✅ 422 错误 |
| 事件频率限制 | ❌ | ✅ 429 限流 |
| Payload 合法性校验 | ❌ | ✅ combo 校验 |
| 文件存储容错 | ❌ | ✅ 损坏恢复 |
| API 级测试 | 基础 | ✅ 全面覆盖 |

### 关键修改文件

| 文件 | 修改内容 |
|------|----------|
| `src/config.js` | 新增风控配置参数 |
| `src/services/session-service.js` | 新增 `validateEventPayload`, `validateEventOrder`, `validateEventFrequency` |
| `src/utils/file-store.js` | 新增 `readJsonSafe`, `readLinesSafe`, `listSessionsSafe` |
| `src/utils/lock.js` | 修复目录不存在时的锁创建问题 |
| `tests/api.test.js` | 新增 17 个 API 级测试用例 |
| `tests/concurrency.test.js` | 新增 6 个并发测试用例 |
| `README.md` | 新增边界行为说明、差异对比、测试结果 |

## 测试结果

### 测试统计

```
✅ 测试总数: 44
✅ 通过: 44
❌ 失败: 0
⏱️ 总耗时: ~5.1 秒
```

### 测试用例分类

#### API 级测试（17 个）

| 测试 | 覆盖场景 |
|------|----------|
| `duplicate startSession requests` | 重复启动 |
| `duplicate finishSession requests` | 重复结算 |
| `invalid session id returns 404` | 不存在的 session |
| `invalid event type returns 422` | 无效事件类型 |
| `negative combo value returns 422` | 负 combo |
| `combo value exceeding max returns 422` | combo 超限 |
| `finish on created session returns 409` | 状态机限制 |
| `addEvent on created session returns 409` | 状态机限制 |
| `expired session returns 410` | 过期处理 |
| `event timestamp out of order returns 422` | 事件倒流 |
| `player name normalization` | 名称标准化 |
| `closeSession on finished session returns 409` | 状态机限制 |
| `startSession on finished session returns 409` | 状态机限制 |
| `getSession returns all fields` | 字段完整性 |
| `closed session not in leaderboard` | 排行榜过滤 |
| `cleanupExpiredSessions returns count` | 过期清理 |

#### 并发测试（6 个）

| 测试 | 覆盖场景 |
|------|----------|
| `concurrent finishSession calls` | 5 并发结算，只有 1 次成功 |
| `concurrent addEvent calls` | 10 并发事件，全部保存 |
| `addEvent order - log written before session` | 写入顺序一致性 |
| `startSession atomic update` | 启动原子性 |
| `closeSession atomic update` | 关闭原子性 |
| `different sessions don't block each other` | 多 session 隔离 |

#### 核心测试（21 个）

包含状态机、过期、风控、排行榜等基础功能测试。

### 运行测试

```bash
# 运行所有测试
npm test

# 运行特定测试文件
node --test tests/api.test.js
node --test tests/concurrency.test.js
node --test tests/core.test.js
```

## 操作管理框架（Operation Manager Framework）

### 概述

新增的通用操作管理框架提供了统一的任务管理能力，支持多种操作类型（如 recovery、export、import）。

### 核心功能

#### 1. 任务注册系统

操作类型可以通过 `registerOperation()` 注册到框架中，每个操作类型定义：
- `handler`: 操作执行函数
- `rollbackHandler`: 回滚函数（可选）
- `config`: 配置（超时、重试、并发控制等）

#### 2. 并发隔离机制

基于 `concurrencyKey` 的并发控制：
- 相同 `concurrencyKey` 的操作会排队执行
- 可配置 `maxConcurrency` 控制最大并发数
- 防止相同类型操作并发执行导致的数据竞争

#### 3. 超时取消功能

- 可配置 `timeoutMs` 定义操作超时时间
- 超时后自动中断操作
- 支持自定义中断检查（`isInterrupted()`）

#### 4. 失败重试机制

- 可配置 `maxRetries` 最大重试次数
- 可配置 `retryDelayMs` 重试延迟
- 支持自动回滚后重试

#### 5. 操作历史查询

所有操作都会持久化到历史目录，支持：
- `listOperationHistory()` - 列出历史记录
- `getOperationHistory()` - 获取单条历史详情
- 历史记录包含完整的操作状态、报告、时间等信息

#### 6. 统一事件流

所有操作事件通过统一的事件发射器发射：
- `onOperationEvent()` - 监听操作事件
- `readOperationEvents()` - 读取持久化的事件日志
- 事件类型：`STARTED`, `PROGRESS`, `COMPLETED`, `FAILED`, `CANCELLED`, `TIMED_OUT`, `ROLLING_BACK`, `ROLLED_BACK`

### 操作状态

```javascript
const OPERATION_STATES = {
  IDLE: "idle",           // 空闲
  PENDING: "pending",     // 等待执行（队列中）
  RUNNING: "running",     // 执行中
  PAUSED: "paused",       // 已暂停
  INTERRUPTED: "interrupted",  // 已中断
  COMPLETED: "completed", // 已完成
  FAILED: "failed",       // 已失败
  ROLLING_BACK: "rolling_back", // 回滚中
  ROLLED_BACK: "rolled_back",   // 已回滚
  TIMED_OUT: "timed_out"  // 已超时
};
```

### 默认配置

```javascript
const DEFAULT_OPERATION_CONFIG = {
  maxRetries: 3,              // 最大重试次数
  retryDelayMs: 1000,          // 重试延迟（毫秒）
  timeoutMs: 300000,           // 超时时间（毫秒，默认 5 分钟）
  concurrencyKey: null,        // 并发键（null 表示不隔离）
  maxConcurrency: 1,           // 最大并发数
  autoRollbackOnFailure: true, // 失败时自动回滚
  persistEvents: true          // 持久化事件
};
```

### 环境变量配置

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `OPERATION_DEFAULT_MAX_RETRIES` | 3 | 默认最大重试次数 |
| `OPERATION_DEFAULT_RETRY_DELAY_MS` | 1000 | 默认重试延迟（毫秒） |
| `OPERATION_DEFAULT_TIMEOUT_MS` | 300000 | 默认超时时间（毫秒） |
| `OPERATION_DEFAULT_MAX_CONCURRENCY` | 1 | 默认最大并发数 |
| `OPERATION_AUTO_ROLLBACK` | true | 失败时自动回滚 |
| `OPERATION_PERSIST_EVENTS` | true | 持久化事件到日志 |

## Recovery 模块增强

### 概述

Recovery 模块已重构接入新的 Operation Manager 框架，获得所有框架能力：并发隔离、超时取消、失败重试、操作历史、事件流。

### 新增 API 接口

#### `GET /api/recovery/operations`

列出当前活跃的 recovery 操作。

响应：
```json
{
  "ok": true,
  "operations": [
    {
      "id": "op_xxx",
      "type": "recovery",
      "state": "running",
      "dryRun": false,
      "createdAt": "2026-04-27T00:00:00.000Z",
      "progress": {
        "phase": "scanning",
        "total": 100,
        "current": 45
      }
    }
  ]
}
```

#### `GET /api/recovery/operations/:operationId`

获取单个操作详情。

#### `POST /api/recovery/operations/:operationId/cancel`

取消正在执行的操作。

响应：
```json
{
  "ok": true,
  "operationId": "op_xxx",
  "state": "interrupted"
}
```

#### `GET /api/recovery/history`

列出 recovery 操作历史。

查询参数：
- `limit`: 返回数量限制，默认 20
- `offset`: 偏移量，默认 0

响应：
```json
{
  "ok": true,
  "history": [
    {
      "id": "op_xxx",
      "type": "recovery",
      "state": "completed",
      "dryRun": true,
      "createdAt": "2026-04-27T00:00:00.000Z",
      "completedAt": "2026-04-27T00:01:30.000Z",
      "report": {
        "summary": { "totalSessions": 10, "recovered": 8 }
      }
    }
  ],
  "total": 42
}
```

#### `GET /api/recovery/history/:operationId`

获取单条历史详情。

#### `GET /api/recovery/events`

读取 recovery 事件流。

查询参数：
- `limit`: 返回数量限制，默认 100
- `offset`: 偏移量，默认 0

响应：
```json
{
  "ok": true,
  "events": [
    {
      "timestamp": "2026-04-27T00:00:00.000Z",
      "type": "started",
      "operationId": "op_xxx",
      "operationType": "recovery",
      "data": { "dryRun": false }
    }
  ]
}
```

### Recovery 目录结构

```text
data/
  backups/              # 操作前备份
  recovery-reports/     # Recovery 报告
  recovery-state.json   # 操作状态
  recovery-temp/        # 临时文件
  recovery-history/     # 操作历史
    op_xxx.json
  recovery-events.log   # 事件日志
  quarantine/           # 隔离的损坏文件
```

## 数据导出/导入（Export/Import）

### 概述

新增完整的数据导出/导入功能，支持：
- 完整数据备份（sessions、events log、leaderboard）
- 可选 gzip 压缩
- 多种合并策略（跳过、覆盖、合并）
- 操作前自动备份
- 失败自动回滚

### 导出功能

#### `POST /api/export-import/export`

执行数据导出。

请求体（可选）：
```json
{
  "compress": true,
  "includeSessions": true,
  "includeEvents": true,
  "includeLeaderboard": true
}
```

- `compress`: 是否压缩，默认 true
- `includeSessions`: 是否包含会话数据，默认 true
- `includeEvents`: 是否包含事件日志，默认 true
- `includeLeaderboard`: 是否包含排行榜，默认 true

响应：
```json
{
  "ok": true,
  "operationId": "exp_xxx",
  "state": "running"
}
```

#### `GET /api/export-import/exports`

列出现有导出包。

响应：
```json
{
  "ok": true,
  "exports": [
    {
      "id": "exp_20260427_000000",
      "createdAt": "2026-04-27T00:00:00.000Z",
      "size": 1048576,
      "compressed": true,
      "filename": "export_20260427_000000.tar.gz",
      "manifest": {
        "sessions": 50,
        "events": 1500,
        "leaderboardEntries": 30
      }
    }
  ]
}
```

#### `GET /api/export-import/exports/:exportId`

获取导出详情。

#### `DELETE /api/export-import/exports/:exportId`

删除导出包。

### 导入功能

#### `POST /api/export-import/import/validate`

验证导入包格式。

请求体：
```json
{
  "filePath": "path/to/export.tar.gz",
  "strategy": "merge"
}
```

- `filePath`: 导入包路径（相对于 imports 目录）
- `strategy`: 合并策略
  - `skip_existing`: 跳过已存在的数据（默认）
  - `overwrite`: 覆盖已存在的数据
  - `merge`: 合并数据

响应：
```json
{
  "ok": true,
  "valid": true,
  "manifest": {
    "version": "1.0",
    "createdAt": "2026-04-27T00:00:00.000Z",
    "sessions": 50,
    "events": 1500,
    "leaderboardEntries": 30
  }
}
```

#### `POST /api/export-import/import`

执行数据导入。

请求体：
```json
{
  "filePath": "export_20260427_000000.tar.gz",
  "strategy": "merge",
  "createBackup": true
}
```

- `filePath`: 导入包文件名（必须在 imports 目录中）
- `strategy`: 合并策略（同上）
- `createBackup`: 导入前是否创建备份，默认 true

响应：
```json
{
  "ok": true,
  "operationId": "imp_xxx",
  "state": "running"
}
```

#### `GET /api/export-import/imports`

列出可用的导入源（imports 目录中的文件）。

### 导出/导入操作管理

#### `GET /api/export-import/operations/exports`

列出活跃的导出操作。

#### `GET /api/export-import/operations/imports`

列出活跃的导入操作。

#### `GET /api/export-import/operations/:operationId`

获取操作详情。

#### `POST /api/export-import/operations/:operationId/cancel`

取消操作。

### 导出/导入历史和事件

#### `GET /api/export-import/history/exports`

列出导出历史。

#### `GET /api/export-import/history/imports`

列出导入历史。

#### `GET /api/export-import/events/exports`

读取导出事件流。

#### `GET /api/export-import/events/imports`

读取导入事件流。

### 备份恢复

导入操作会自动创建备份，可以从备份恢复：

#### `GET /api/export-import/backups/imports`

列出导入操作的备份。

#### `POST /api/export-import/backups/imports/:backupId/restore`

从备份恢复。

### 导出/导入目录结构

```text
data/
  exports/              # 导出的包
    export_20260427_000000.tar.gz
  imports/              # 待导入的包
    import_data.tar.gz
  export-reports/       # 导出报告
  export-state.json     # 导出操作状态
  export-temp/          # 导出临时文件
  export-history/       # 导出历史
  export-events.log     # 导出事件日志
  import-reports/       # 导入报告
  import-state.json     # 导入操作状态
  import-temp/          # 导入临时文件
  import-history/       # 导入历史
  import-events.log     # 导入事件日志
```

### 导出包格式

导出包是一个 tar 归档（可选 gzip 压缩），包含：

```text
export_xxx.tar.gz
├── manifest.json       # 元数据
├── sessions/           # 会话文件
│   ├── sess_xxx.json
│   └── ...
├── events.log          # 事件日志
└── leaderboard.json    # 排行榜数据
```

manifest.json 格式：
```json
{
  "version": "1.0",
  "createdAt": "2026-04-27T00:00:00.000Z",
  "compressed": true,
  "content": {
    "sessions": 50,
    "events": 1500,
    "leaderboardEntries": 30
  },
  "checksums": {
    "sessions": "sha256:...",
    "events.log": "sha256:...",
    "leaderboard.json": "sha256:..."
  }
}
```

## 完整 API 清单

### 核心 API
- `GET /healthz` - 健康检查
- `POST /api/sessions` - 创建会话
- `GET /api/sessions/:sessionId` - 查询会话
- `POST /api/sessions/:sessionId/start` - 启动会话
- `POST /api/sessions/:sessionId/events` - 上报事件
- `POST /api/sessions/:sessionId/finish` - 结束并结算
- `POST /api/sessions/:sessionId/close` - 关闭会话
- `POST /api/sessions/cleanup-expired` - 清理过期会话
- `GET /api/leaderboard` - 排行榜查询

### Recovery API
- `POST /api/recovery/run` - 执行恢复
- `GET /api/recovery/status` - 获取状态
- `GET /api/recovery/reports` - 列出报告
- `GET /api/recovery/reports/:reportId` - 获取报告详情
- `GET /api/recovery/backups` - 列出备份
- `POST /api/recovery/backups/:backupId/restore` - 从备份恢复
- `GET /api/recovery/quarantine` - 列出隔离文件
- `POST /api/recovery/interrupt` - 中断恢复
- `GET /api/recovery/config` - 获取配置
- `GET /api/recovery/operations` - 列出活跃操作
- `GET /api/recovery/operations/:operationId` - 获取操作详情
- `POST /api/recovery/operations/:operationId/cancel` - 取消操作
- `GET /api/recovery/history` - 列出历史
- `GET /api/recovery/history/:operationId` - 获取历史详情
- `GET /api/recovery/events` - 读取事件流

### Export/Import API
- `GET /api/export-import/status` - 状态检查
- `GET /api/export-import/config` - 获取配置
- `POST /api/export-import/export` - 执行导出
- `GET /api/export-import/exports` - 列出现有导出
- `GET /api/export-import/exports/:exportId` - 获取导出详情
- `DELETE /api/export-import/exports/:exportId` - 删除导出
- `POST /api/export-import/import/validate` - 验证导入包
- `POST /api/export-import/import` - 执行导入
- `GET /api/export-import/imports` - 列出导入源
- `GET /api/export-import/operations/exports` - 列出活跃导出操作
- `GET /api/export-import/operations/imports` - 列出活跃导入操作
- `GET /api/export-import/operations/:operationId` - 获取操作详情
- `POST /api/export-import/operations/:operationId/cancel` - 取消操作
- `GET /api/export-import/history/exports` - 列出导出历史
- `GET /api/export-import/history/imports` - 列出导入历史
- `GET /api/export-import/history/:operationId` - 获取历史详情
- `GET /api/export-import/events/exports` - 读取导出事件
- `GET /api/export-import/events/imports` - 读取导入事件
- `GET /api/export-import/backups/imports` - 列出导入备份
- `POST /api/export-import/backups/imports/:backupId/restore` - 从备份恢复

## 测试结果

### 测试统计

```
✅ 测试总数: 72
✅ 通过: 72
❌ 失败: 0
⏱️ 总耗时: ~16-20 秒
```

### 测试用例分类

#### API 测试（16 个）
- 会话创建、启动、事件上报、结算、关闭
- 过期处理、重复提交防护
- 状态机边界验证
- 排行榜分页

#### 并发测试（6 个）
- 并发结算（只有 1 次成功）
- 并发事件（全部保存）
- 原子性保证
- 多 session 隔离

#### 核心测试（21 个）
- 状态机转换
- Session 服务
- 分数计算
- Leaderboard 服务

#### Recovery 测试（29 个）
- 会话文件丢失恢复
- 损坏日志检测
- 重复事件检测
- 状态冲突检测
- 重复入榜防护
- dry-run 模式
- 隔离功能
- 备份创建和恢复
- 事务和回滚
- 性能测试（100 会话，5000 事件）

### 运行测试

```bash
# 运行所有测试
npm test

# 运行单个测试文件
node --test tests/recovery.test.js
node --test tests/api.test.js
node --test tests/concurrency.test.js
node --test tests/core.test.js
```

## 新增/修改文件清单

### 新增文件

| 文件 | 说明 |
|------|------|
| `src/services/operation-manager.js` | 通用操作管理框架（核心） |
| `src/services/export-import-manager.js` | 数据导出/导入服务 |
| `src/routes/export-import.js` | 导出/导入 API 路由 |

### 修改文件

| 文件 | 修改内容 |
|------|----------|
| `src/config.js` | 新增操作管理、导出/导入配置参数 |
| `src/services/recovery-manager.js` | 重构接入 Operation Manager 框架 |
| `src/routes/recovery.js` | 新增操作管理、历史、事件流 API |
| `src/app.js` | 集成 export-import 路由 |
| `README.md` | 新增框架说明、API 文档、测试结果 |
