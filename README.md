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
- 统一的 JSON 归档格式（可选 gzip 压缩）
- 三种合并策略（跳过、覆盖、智能合并）
- 操作前自动备份
- 失败自动回滚
- 重复导入检测
- 支持大文件流式处理
- 操作可取消

### 导出包格式与命名

#### 命名规范

导出包使用统一的命名格式：
```
catrank-export-YYYYMMDD-HHMMSS-{short-id}.json.gz
```

示例：
```
catrank-export-20260430-143022-abc123.json.gz
```

- `YYYYMMDD`: 日期（年-月-日）
- `HHMMSS`: 时间（时-分-秒）
- `short-id`: 8 字符随机 ID

#### 文件格式

导出包是一个 JSON 归档文件，支持两种格式：
- 压缩格式：`.json.gz`（gzip 压缩，默认）
- 非压缩格式：`.json`（纯 JSON）

内部结构：
```json
{
  "manifest": {
    "id": "catrank-export-20260430-143022-abc123",
    "version": "1.1",
    "createdAt": "2026-04-30T14:30:22.000Z",
    "includes": {
      "sessions": true,
      "leaderboard": true,
      "eventLog": true
    },
    "sessionCount": 50,
    "leaderboardEntryCount": 30,
    "eventCount": 1500
  },
  "files": {
    "manifest.json": "...",
    "sessions/sess_xxx.json": "...",
    "sessions/sess_yyy.json": "...",
    "leaderboard.json": "...",
    "events.json": "..."
  }
}
```

### 合并策略详解

导入支持三种合并策略，每种策略在不同数据类型上有不同的行为：

#### skip_existing（默认）

| 数据类型 | 行为 |
|---------|------|
| **Sessions** | 跳过已存在的 session（按 session.id 判断），只导入新的 |
| **Leaderboard** | 跳过已存在的 sessionId，只添加新条目 |
| **Event Log** | 跳过已存在的 event.id，只添加新事件 |

使用场景：从不同环境导入数据，避免覆盖现有数据。

#### overwrite

| 数据类型 | 行为 |
|---------|------|
| **Sessions** | 完全覆盖：如果 session 已存在则覆盖，不存在则添加 |
| **Leaderboard** | 完全替换：整个 leaderboard 被导入数据替换 |
| **Event Log** | 完全替换：清空现有日志，写入导入的日志 |

使用场景：完全替换现有数据，恢复到导出时的状态。

#### merge（智能合并）

| 数据类型 | 行为 |
|---------|------|
| **Sessions** | 比较时间戳：如果导入的 session 有更新的时间（updatedAt/closedAt/finishedAt/createdAt）则覆盖，否则保留现有 |
| **Leaderboard** | 保留最高分：如果导入的 entry 分数更高则替换，否则保留现有 |
| **Event Log** | 去重添加：跳过已存在的 event.id，只添加新事件（同 skip_existing） |

使用场景：合并来自不同时间点的数据，保留最新/最优状态。

### 导入校验与错误处理

#### 校验层级

导入包会经过多层校验：

1. **格式校验**：检查是否为有效的 JSON 归档
2. **Manifest 校验**：检查 manifest 中的必需字段
3. **版本校验**：检查格式版本兼容性
4. **数据校验**：
   - Sessions：检查每个 session 是否有 id
   - Leaderboard：检查是否为数组，每个条目是否有 sessionId 和 score
   - Event Log：检查是否为数组

#### 错误类型

| 错误类型 | severity | recoverable | 说明 |
|---------|----------|-------------|------|
| missing_manifest | error | false | 缺少 manifest.json |
| invalid_manifest | error | false | manifest 缺少必需字段 |
| version_incompatible | error | false | 版本过高，无法兼容 |
| invalid_session | error | true | 单个 session 无效 |
| corrupted_session | error | true | 单个 session 文件损坏 |
| invalid_leaderboard | error | true | leaderboard 格式错误 |
| invalid_events | error | true | 事件日志格式错误 |
| sessions_read_error | error | false | 无法读取 sessions 目录 |

#### 忽略可恢复错误

如果设置 `ignoreValidationErrors: true`，可恢复错误（recoverable: true）会被忽略，导入继续执行：

```json
{
  "source": "catrank-export-xxx.json.gz",
  "strategy": "merge",
  "ignoreValidationErrors": true
}
```

### 重复导入检测

系统会自动检测重复导入：

1. 每个导出包有唯一的 `exportId`（存储在 manifest.id）
2. 导入历史记录在 `data/import-history/` 目录
3. 导入前会检查该 exportId 是否已被导入

#### 允许重复导入

如果需要重复导入同一个包，可以设置 `allowDuplicateImport: true`：

```json
{
  "source": "catrank-export-xxx.json.gz",
  "strategy": "merge",
  "allowDuplicateImport": true
}
```

### 取消任务

导出/导入操作支持取消：

1. **调用取消 API**：`POST /api/export-import/operations/:operationId/cancel`
2. **中断检查点**：操作在关键步骤会检查是否被中断
   - 导出：读取 sessions、读取 leaderboard、读取 events、写入归档
   - 导入：提取包、校验、导入 sessions、导入 leaderboard、导入 events
3. **清理**：取消后会清理临时文件

### 回滚恢复

导入操作内置回滚机制：

1. **自动备份**：导入前会自动备份以下资源：
   - sessions 目录 → `data/backups/import_xxx/sessions/`
   - events.log → `data/backups/import_xxx/events.log`
   - leaderboard.json → `data/backups/import_xxx/leaderboard.json`

2. **失败自动回滚**：如果导入失败且 `autoRollbackOnFailure` 为 true（默认），会自动从备份恢复

3. **手动恢复**：可以通过 API 手动恢复：
   ```
   POST /api/export-import/backups/imports/:backupId/restore
   ```

### 大文件处理

系统针对大文件做了以下优化：

#### 事件日志流式处理

事件日志使用 `readline` 模块流式读取：
- 不会一次性加载全部内容到内存
- 支持超大事件日志（GB 级别）
- 批量写入（每 1000 个事件一批）

#### 内存优化

| 操作 | 优化方式 |
|------|----------|
| 读取事件日志 | 流式逐行读取，不加载全部到内存 |
| 写入事件日志 | 批量写入，减少 I/O 次数 |
| 导入操作 | 逐文件处理，不一次性加载所有数据 |

### 导出功能

#### `POST /api/export-import/export`

执行数据导出。

请求体（可选）：
```json
{
  "compress": true,
  "includeSessions": true,
  "includeLeaderboard": true,
  "includeEventLog": true,
  "dryRun": false
}
```

- `compress`: 是否 gzip 压缩，默认 true
- `includeSessions`: 是否包含会话数据，默认 true
- `includeLeaderboard`: 是否包含排行榜，默认 true
- `includeEventLog`: 是否包含事件日志，默认 true
- `dryRun`: 是否为试运行，默认 false（导出不支持 dry-run，此参数无效）

响应：
```json
{
  "ok": true,
  "dryRun": false,
  "operationId": "op_abc123",
  "result": {
    "success": true,
    "exportId": "catrank-export-20260430-143022-abc123",
    "outputPath": "data/exports/catrank-export-20260430-143022-abc123.json.gz",
    "compressed": true,
    "fileSize": 1048576,
    "manifest": {
      "id": "catrank-export-20260430-143022-abc123",
      "version": "1.1",
      "sessionCount": 50,
      "leaderboardEntryCount": 30,
      "eventCount": 1500
    }
  }
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
      "id": "catrank-export-20260430-143022-abc123",
      "name": "catrank-export-20260430-143022-abc123.json.gz",
      "size": 1048576,
      "createdAt": "2026-04-30T14:30:22.000Z",
      "isCompressed": true,
      "manifest": {
        "sessionCount": 50,
        "leaderboardEntryCount": 30,
        "eventCount": 1500
      }
    }
  ],
  "count": 1
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
  "source": "catrank-export-20260430-143022-abc123.json.gz",
  "importSessions": true,
  "importLeaderboard": true,
  "importEventLog": true
}
```

响应：
```json
{
  "ok": true,
  "valid": true,
  "manifest": {
    "id": "catrank-export-20260430-143022-abc123",
    "version": "1.1",
    "sessionCount": 50
  },
  "issues": [],
  "warnings": []
}
```

如果有校验问题：
```json
{
  "ok": false,
  "valid": false,
  "manifest": { ... },
  "issues": [
    {
      "type": "invalid_session",
      "severity": "error",
      "file": "sess_invalid.json",
      "message": "Session missing 'id' field",
      "recoverable": true
    }
  ],
  "warnings": [
    {
      "type": "version_mismatch",
      "severity": "warning",
      "message": "Import package version 1.0 may have different format than current version 1.1"
    }
  ]
}
```

#### `POST /api/export-import/import`

执行数据导入。

请求体：
```json
{
  "source": "catrank-export-20260430-143022-abc123.json.gz",
  "strategy": "merge",
  "importSessions": true,
  "importLeaderboard": true,
  "importEventLog": true,
  "dryRun": true,
  "ignoreValidationErrors": false,
  "allowDuplicateImport": false
}
```

- `source`: 导入包文件名（必须在 `data/imports/` 目录中）
- `strategy`: 合并策略（`skip_existing` / `overwrite` / `merge`）
- `importSessions`: 是否导入会话，默认 true
- `importLeaderboard`: 是否导入排行榜，默认 true
- `importEventLog`: 是否导入事件日志，默认 true
- `dryRun`: 是否为试运行，默认 true（不会实际修改数据）
- `ignoreValidationErrors`: 是否忽略可恢复的校验错误，默认 false
- `allowDuplicateImport`: 是否允许重复导入同一包，默认 false

响应：
```json
{
  "ok": true,
  "dryRun": true,
  "operationId": "op_xyz789",
  "result": {
    "success": true,
    "mergeStrategy": "merge",
    "sessions": {
      "imported": 35,
      "skipped": 10,
      "overwritten": 5,
      "failed": 0,
      "total": 50
    },
    "leaderboard": {
      "imported": 20,
      "skipped": 8,
      "overwritten": 2,
      "failed": 0,
      "total": 30
    },
    "events": {
      "imported": 1200,
      "skipped": 300,
      "failed": 0,
      "total": 1500
    },
    "actions": [
      { "type": "session", "id": "sess_001", "action": "import" },
      { "type": "session", "id": "sess_002", "action": "overwrite", "reason": "newer_version" },
      { "type": "leaderboard_entry", "sessionId": "sess_003", "action": "replace", "reason": "higher_score" }
    ],
    "warnings": [],
    "duplicateCheck": {
      "exportId": "catrank-export-20260430-143022-abc123",
      "wasDuplicate": false
    }
  }
}
```

#### `GET /api/export-import/imports`

列出可用的导入源（`data/imports/` 目录中的文件）。

### 操作管理

#### `GET /api/export-import/operations`

列出所有活跃操作。

响应：
```json
{
  "ok": true,
  "operations": {
    "exports": [
      {
        "id": "op_abc123",
        "type": "export",
        "state": "running",
        "dryRun": false,
        "createdAt": "2026-04-30T14:30:22.000Z",
        "progress": {
          "phase": "sessions",
          "percent": 25,
          "message": "Reading sessions..."
        }
      }
    ],
    "imports": []
  },
  "counts": {
    "exports": 1,
    "imports": 0
  }
}
```

#### `GET /api/export-import/operations/:operationId`

获取操作详情。

#### `POST /api/export-import/operations/:operationId/cancel`

取消操作。

响应：
```json
{
  "ok": true,
  "cancelled": true,
  "operation": {
    "id": "op_abc123",
    "state": "interrupted"
  }
}
```

### 历史与事件

#### `GET /api/export-import/history/exports`

列出导出历史。

查询参数：
- `limit`: 返回数量限制，默认 50
- `offset`: 偏移量，默认 0

#### `GET /api/export-import/history/imports`

列出导入历史。

#### `GET /api/export-import/events/exports`

读取导出事件流。

查询参数：
- `limit`: 返回数量限制，默认 100
- `offset`: 偏移量，默认 0

#### `GET /api/export-import/events/imports`

读取导入事件流。

### 备份恢复

#### `GET /api/export-import/backups/imports`

列出导入操作的备份。

#### `POST /api/export-import/backups/imports/:backupId/restore`

从备份恢复。

响应：
```json
{
  "ok": true,
  "backupId": "backup_xxx",
  "restoredItems": {
    "sessions": 50,
    "eventsLog": true,
    "leaderboard": true
  }
}
```

### 使用示例

#### 1. 导出数据

```bash
curl -X POST http://localhost:3000/api/export-import/export \
  -H "Content-Type: application/json" \
  -H "X-Recovery-Auth: your-recovery-key" \
  -d '{
    "compress": true,
    "includeSessions": true,
    "includeLeaderboard": true,
    "includeEventLog": true
  }'
```

#### 2. 准备导入

将导出包复制到 `data/imports/` 目录：
```bash
cp data/exports/catrank-export-xxx.json.gz data/imports/
```

#### 3. 验证导入包

```bash
curl -X POST http://localhost:3000/api/export-import/import/validate \
  -H "Content-Type: application/json" \
  -H "X-Recovery-Auth: your-recovery-key" \
  -d '{
    "source": "catrank-export-xxx.json.gz"
  }'
```

#### 4. 试运行导入（dry-run）

```bash
curl -X POST http://localhost:3000/api/export-import/import \
  -H "Content-Type: application/json" \
  -H "X-Recovery-Auth: your-recovery-key" \
  -d '{
    "source": "catrank-export-xxx.json.gz",
    "strategy": "merge",
    "dryRun": true
  }'
```

#### 5. 执行真实导入

```bash
curl -X POST http://localhost:3000/api/export-import/import \
  -H "Content-Type: application/json" \
  -H "X-Recovery-Auth: your-recovery-key" \
  -d '{
    "source": "catrank-export-xxx.json.gz",
    "strategy": "merge",
    "dryRun": false
  }'
```

#### 6. 查看导入历史

```bash
curl http://localhost:3000/api/export-import/history/imports
```

#### 7. 如有问题，从备份恢复

```bash
# 列出备份
curl http://localhost:3000/api/export-import/backups/imports

# 恢复
curl -X POST http://localhost:3000/api/export-import/backups/imports/:backupId/restore \
  -H "X-Recovery-Auth: your-recovery-key"
```

### 目录结构

```text
data/
  exports/                    # 导出的包
    catrank-export-20260430-143022-abc123.json.gz
  imports/                    # 待导入的包（需手动放置）
    catrank-export-xxx.json.gz
  export-reports/             # 导出报告
  export-state.json           # 导出操作状态
  export-temp/                # 导出临时文件
  export-history/             # 导出历史
  export-events.log           # 导出事件日志
  import-reports/             # 导入报告
  import-state.json           # 导入操作状态
  import-temp/                # 导入临时文件
  import-history/             # 导入历史（用于重复导入检测）
  import-events.log           # 导入事件日志
  backups/                    # 导入前的备份
    import_xxx/
      sessions/
      events.log
      leaderboard.json
```

### 注意事项

1. **导入包位置**：导入包必须放置在 `data/imports/` 目录中
2. **Recovery Auth**：执行导出、导入、取消、恢复等操作需要 `X-Recovery-Auth` 头
3. **Dry Run**：建议先执行 dry-run 验证结果，再执行真实导入
4. **合并策略**：根据实际需求选择合适的合并策略
5. **大文件**：事件日志支持流式处理，无需担心内存问题
6. **可恢复性**：导入前会自动备份，失败可回滚

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

## 操作证据链（Evidence Chain）

### 概述

新增的操作证据链模块为高风险操作（recovery、import、restore、delete、export）提供了完整的**可审计、可验证、可回放**能力。该模块实现了区块链式的哈希链机制，确保操作记录不可篡改，所有状态变化都有迹可循。

### 核心特性

#### 1. 证据链机制

每次状态变化都会生成证据事件，并使用前一事件的哈希构建哈希链：

```
证据1 (prevHash = "0000...") → currentHash = H(prevHash + data1)
     ↓
证据2 (prevHash = H(prevHash + data1)) → currentHash = H(prevHash + data2)
     ↓
证据3 (prevHash = H(prevHash + data2)) → currentHash = H(prevHash + data3)
```

任何一个证据被篡改，都会导致后续所有哈希验证失败。

#### 2. 证据 ID 生成

每个证据事件都有唯一的 `evidenceId`，格式为：
```
evid_${timestamp}_${8char_random_id}
```

例如：`evid_1710000000000_abc123ef`

#### 3. 参数摘要

操作参数会被排序后计算哈希摘要，用于后续验证：

```javascript
const params = { dryRun: true, target: "session_123" };
const digest = calculateParameterDigest(params);
// "a1b2c3d4..." (64 字符 SHA256 哈希)
```

#### 4. 异常检测

模块能够检测以下异常：

| 检测类型 | 说明 | 错误类型 |
|---------|------|---------|
| **链断裂** | 证据链哈希不连续 | `chain_broken` |
| **时间异常** | 事件时间戳倒流或超前 | `timestamp_out_of_order` |
| **参数摘要不一致** | 操作参数与记录的摘要不符 | 参数验证失败 |

### 高风险操作监控

以下操作类型会被自动记录证据链：

| 操作类型 | 描述 |
|---------|------|
| `recovery` | 数据恢复操作 |
| `import` | 数据导入操作 |
| `restore` | 备份恢复操作 |
| `delete` | 数据删除操作 |
| `export` | 数据导出操作 |

### 证据事件结构

每个证据事件包含以下字段：

```json
{
  "evidenceId": "evid_1710000000000_abc123ef",
  "operationType": "recovery",
  "operationId": "op_1710000000000_xyz789",
  "eventType": "operation_completed",
  "timestamp": "2026-04-27T14:30:22.000Z",
  "state": "completed",
  "previousState": "running",
  "parameterDigest": "a1b2c3d4...",
  "resultDigest": "f5g6h7i8...",
  "errorDigest": null,
  "prevHash": "00000000...",
  "currentHash": "j9k0l1m2...",
  "parameters": { "dryRun": true },
  "result": { "recoveredCount": 5 },
  "error": null,
  "metadata": {}
}
```

### API 接口

所有证据相关接口需要 `X-Recovery-Auth` 认证头。

#### 状态查询

##### `GET /api/evidence/status`

获取证据链模块状态。

响应：
```json
{
  "ok": true,
  "enabled": true,
  "state": {
    "totalEvidenceCount": 150,
    "totalChains": 42,
    "lastEvidenceId": "evid_xxx",
    "lastHash": "abc123..."
  },
  "highRiskOperations": ["recovery", "import", "restore", "delete", "export"]
}
```

#### 操作链管理

##### `GET /api/evidence/chains`

列出所有操作链（支持分页和过滤）。

查询参数：
- `limit`: 返回数量，默认 50，最大 100
- `offset`: 偏移量，默认 0
- `operationType`: 按操作类型过滤

响应：
```json
{
  "ok": true,
  "chains": [
    {
      "operationId": "op_xxx",
      "operationType": "recovery",
      "createdAt": "2026-04-27T14:30:22.000Z",
      "updatedAt": "2026-04-27T14:30:45.000Z",
      "lastEvidenceId": "evid_xxx",
      "lastHash": "abc123...",
      "events": [
        {
          "evidenceId": "evid_1",
          "eventType": "operation_created",
          "timestamp": "...",
          "state": "pending",
          "currentHash": "..."
        }
      ]
    }
  ],
  "total": 42,
  "limit": 50,
  "offset": 0
}
```

##### `GET /api/evidence/chains/:operationId`

获取单个操作链详情。

响应：
```json
{
  "ok": true,
  "operationId": "op_xxx",
  "chain": { ... },
  "evidences": [ ... ]
}
```

#### 链校验

##### `POST /api/evidence/chains/:operationId/validate`

校验单个操作链的完整性。

响应：
```json
{
  "ok": true,
  "operationId": "op_xxx",
  "valid": true,
  "issues": [],
  "warnings": [],
  "details": {
    "eventCount": 5,
    "validCount": 5,
    "invalidCount": 0
  }
}
```

如果存在问题：
```json
{
  "ok": true,
  "operationId": "op_xxx",
  "valid": false,
  "issues": [
    {
      "type": "chain_broken",
      "severity": "error",
      "eventIndex": 3,
      "evidenceId": "evid_xxx",
      "message": "Hash chain broken at event 3",
      "expectedHash": "abc123...",
      "actualHash": "def456..."
    },
    {
      "type": "timestamp_out_of_order",
      "severity": "error",
      "eventIndex": 2,
      "evidenceId": "evid_yyy",
      "message": "Event 2 timestamp is earlier than previous event"
    }
  ]
}
```

##### `POST /api/evidence/validate-all`

校验所有操作链。

响应：
```json
{
  "ok": true,
  "total": 42,
  "valid": 40,
  "invalid": 2,
  "failedChains": [
    {
      "operationId": "op_xxx",
      "operationType": "recovery",
      "issues": [ ... ]
    }
  ]
}
```

#### 操作回放

##### `POST /api/evidence/replay/:operationId`

根据证据链回放操作历史。

请求体：
```json
{
  "dryRun": true
}
```

- `dryRun`: 是否为试运行模式，默认 `true`（仅记录回放日志，不执行实际操作）

响应：
```json
{
  "ok": true,
  "operationId": "op_xxx",
  "operationType": "recovery",
  "dryRun": true,
  "finalState": "completed",
  "eventCount": 5,
  "replayLog": [
    {
      "step": 1,
      "evidenceId": "evid_1",
      "eventType": "operation_created",
      "timestamp": "...",
      "previousState": null,
      "targetState": "pending",
      "parameters": { "dryRun": true },
      "parameterDigest": "abc123..."
    },
    {
      "step": 2,
      "evidenceId": "evid_2",
      "eventType": "operation_started",
      "targetState": "running"
    }
  ],
  "message": "Dry run completed - no actual changes made"
}
```

#### 证据导出

##### `GET /api/evidence/export/:operationId`

导出完整的证据链（JSON 格式下载）。

响应：
- Content-Type: `application/json`
- Content-Disposition: `attachment; filename="evidence_op_xxx_1710000000000.json"`

导出的内容：
```json
{
  "exportId": "export_evid_1710000000000",
  "exportedAt": "2026-04-27T14:35:00.000Z",
  "operationId": "op_xxx",
  "operationType": "recovery",
  "evidences": [
    { "evidenceId": "evid_1", ... },
    { "evidenceId": "evid_2", ... }
  ],
  "chain": { ... }
}
```

#### 日志查询

##### `GET /api/evidence/logs`

查询证据日志（按时间倒序）。

查询参数：
- `limit`: 返回数量，默认 100，最大 1000
- `offset`: 偏移量，默认 0

响应：
```json
{
  "ok": true,
  "logs": [
    { "evidenceId": "evid_xxx", "operationType": "recovery", "eventType": "operation_completed", ... }
  ],
  "total": 150,
  "limit": 100,
  "offset": 0
}
```

##### `GET /api/evidence/logs/:evidenceId`

获取单个证据详情。

响应：
```json
{
  "ok": true,
  "evidence": {
    "evidenceId": "evid_xxx",
    "operationType": "recovery",
    "operationId": "op_xxx",
    "eventType": "operation_completed",
    "timestamp": "...",
    "state": "completed",
    "previousState": "running",
    "parameterDigest": "abc123...",
    "resultDigest": "def456...",
    "prevHash": "0000...",
    "currentHash": "xyz789..."
  }
}
```

#### 参数一致性校验

##### `POST /api/evidence/verify-parameters`

验证实际操作参数是否与记录的参数摘要一致。

请求体：
```json
{
  "evidenceId": "evid_xxx",
  "operationId": "op_xxx",
  "actualParameters": {
    "dryRun": true,
    "target": "session_123"
  }
}
```

响应：
```json
{
  "ok": true,
  "evidenceId": "evid_xxx",
  "consistent": true,
  "expectedDigest": "abc123...",
  "actualDigest": "abc123...",
  "evidenceParameters": { "dryRun": true, "target": "session_123" },
  "actualParameters": { "dryRun": true, "target": "session_123" }
}
```

如果不一致：
```json
{
  "ok": true,
  "evidenceId": "evid_xxx",
  "consistent": false,
  "expectedDigest": "abc123...",
  "actualDigest": "def456..."
}
```

### 配置参数

通过环境变量配置：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `EVIDENCE_ENABLED` | `true` | 是否启用证据链模块 |
| `EVIDENCE_HASH_ALGORITHM` | `sha256` | 哈希算法（sha256 / sha512） |
| `EVIDENCE_MAX_TIME_SKEW_MS` | `60000` | 时间戳最大容忍偏差（毫秒，默认 1 分钟） |

### 目录结构

```text
data/
  evidence/
    evidence.log           # 证据日志（所有操作的证据链）
    state.json             # 证据链状态
    chains/                # 按操作分组的链文件
      op_xxx.json
      op_yyy.json
    exports/               # 导出的证据链文件
      evidence_op_xxx_1710000000000.json
```

### 证据链集成点

证据链自动在以下位置集成：

| 位置 | 事件类型 | 触发条件 |
|------|---------|---------|
| `createOperation` | `operation_created` | 操作创建时 |
| `updateOperation` (状态: pending → running) | `operation_started` | 操作开始执行时 |
| `updateOperation` (状态: running → completed) | `operation_completed` | 操作成功完成时 |
| `updateOperation` (状态: running → failed) | `operation_failed` | 操作失败时 |
| `updateOperation` (状态: failed → rolling_back) | `operation_rolling_back` | 开始回滚时 |
| `updateOperation` (状态: rolling_back → rolled_back) | `operation_rolled_back` | 回滚完成时 |
| `cancelOperation` | `operation_interrupted` | 操作被取消时 |

### 篡改检测测试

模块包含完整的篡改检测测试，覆盖以下场景：

| 测试场景 | 预期结果 |
|---------|---------|
| 哈希链某一环被修改 | `chain_broken` 错误 |
| 事件时间戳倒流 | `timestamp_out_of_order` 错误 |
| 操作参数被篡改 | 参数摘要不一致 |
| 删除某一事件 | 哈希链断裂 |
| 新增伪造事件 | 哈希校验失败 |

### 测试结果

#### 测试统计

```
✅ 测试总数: 89
✅ 通过: 89
❌ 失败: 0
⏱️ 总耗时: ~18 秒
```

#### 证据链测试用例（15 个）

| 测试用例 | 覆盖场景 |
|---------|---------|
| `generateEvidenceId produces valid IDs` | 证据 ID 格式和唯一性 |
| `calculateHash produces consistent hashes` | 哈希计算一致性 |
| `calculateParameterDigest handles parameters correctly` | 参数摘要计算（排序敏感性） |
| `createEvidence creates valid evidence` | 证据创建完整性 |
| `createEvidence builds proper hash chain` | 哈希链构建正确性 |
| `getOperationChain returns chain for operation` | 操作链查询 |
| `validateEvidenceChain detects broken chain` | 链断裂检测 |
| `validateEvidenceChain detects timestamp out of order` | 时间异常检测 |
| `verifyParameterConsistency detects parameter tampering` | 参数篡改检测 |
| `getEvidenceByOperationId returns all evidences` | 证据查询 |
| `replayOperationFromEvidence replays events` | 操作回放 |
| `exportEvidenceChain exports valid data` | 证据导出 |
| `getEvidenceState returns correct state` | 状态查询 |
| `validateAllEvidenceChains validates all chains` | 全链校验 |
| `listAllOperationChains supports pagination and filtering` | 分页和过滤 |

#### 运行测试

```bash
# 运行所有测试
npm test

# 仅运行证据链测试
node --test tests/evidence.test.js
```

### 新增/修改文件清单

#### 新增文件

| 文件 | 说明 |
|------|------|
| `src/services/evidence-chain-service.js` | 证据链核心服务 |
| `src/routes/evidence.js` | 证据链 API 路由 |
| `tests/evidence.test.js` | 证据链测试用例 |

#### 修改文件

| 文件 | 修改内容 |
|------|----------|
| `src/config.js` | 新增证据链配置参数 |
| `src/services/operation-manager.js` | 集成证据链记录（状态变化时记录证据） |
| `src/app.js` | 集成 evidence 路由 |
| `README.md` | 新增证据链模块说明、API 文档、测试结果 |

### 与现有模块的关系

```
┌─────────────────────────────────────────────────────────────┐
│                      CatRank Server                          │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │   Recovery   │  │ Export/Import│  │  Evidence Chain  │  │
│  │   Manager    │  │   Manager    │  │    (本模块)      │  │
│  └──────┬───────┘  └──────┬───────┘  └─────────┬────────┘  │
│         │                 │                     │            │
│         └─────────────────┼─────────────────────┘            │
│                           ▼                                  │
│              ┌─────────────────────────┐                    │
│              │   Operation Manager     │                    │
│              │  (统一操作管理框架)       │                    │
│              └───────────┬─────────────┘                    │
│                          ▼                                   │
│              ┌─────────────────────────┐                    │
│              │  Evidence Chain Service │                    │
│              │  (状态变化时自动记录证据) │                    │
│              └─────────────────────────┘                    │
└─────────────────────────────────────────────────────────────┘
```

### 设计原则

1. **不可篡改性**：使用 SHA256 哈希链，任何篡改都会导致哈希验证失败
2. **可审计性**：所有高风险操作的每个状态变化都有完整记录
3. **可验证性**：提供校验接口，可随时验证证据链完整性
4. **可回放性**：根据证据链可重现操作的完整状态变化过程
5. **异常检测**：自动检测链断裂、时间异常、参数不一致等问题
6. **零侵入**：通过 Operation Manager 自动集成，无需修改业务代码
7. **可配置**：支持禁用、调整时间容忍度、切换哈希算法

### 修复记录（2026-05-02）

#### 问题1：evidence status 接口不应返回服务端本地路径

**修复前**：`GET /api/evidence/status` 接口返回 `evidenceDir` 和 `logFile` 等服务端本地路径，存在信息泄露风险。

**修复后**：移除了敏感路径字段，响应中不再包含 `evidenceDir` 和 `logFile`。

#### 问题2：logs 接口分页参数仍是手写解析，非法值要改成明确校验失败

**修复前**：`GET /api/evidence/logs` 接口使用手写解析分页参数，使用 `parseInt` 和默认值，非法值（如 `limit=0`、`limit=-1`、`limit="abc"`）不会明确失败。

**修复后**：新增 `listLogsSchema` 使用 zod 进行严格校验：
- `limit`: 必须是 1-1000 之间的整数
- `offset`: 必须是 >=0 的整数
- 非法值会触发明确的 ZodError 校验失败

#### 问题3：证据链校验要补 currentHash 重算比对，不能只查 prevHash

**修复前**：`validateEvidenceChain` 只检查 `prevHash === prevEvent.currentHash`，没有验证 `currentHash` 本身是否由数据正确计算得出。如果攻击者篡改了证据数据并同时修改了 `prevHash` 链接，这种校验无法检测。

**修复后**：
- 新增 `rebuildEvidenceCurrentHash(evidence)` 函数：根据证据数据重新计算 `currentHash`
- 新增 `validateEvidenceChainFull(operationId)` 函数：使用完整证据数据进行完整校验
- 增强 `validateEvidenceChain(chain, fullEvidences)` 函数：接受可选的 `fullEvidences` 参数，当提供时进行 `currentHash` 重算比对
- 新增检测类型 `hash_tampered`：当 `currentHash` 被篡改时触发

**校验流程**：
```
1. 检查 prevHash === prevEvent.currentHash (链完整性)
2. 检查时间戳顺序 (时间异常)
3. [新增] 重算 currentHash 并比对 (数据篡改检测)
```

#### 问题4：回放逻辑要补状态重建校验，不能只返回事件列表

**修复前**：`replayOperationFromEvidence` 只返回事件列表，没有进行状态流转验证、哈希验证等。

**修复后**：
- 新增 `VALID_STATE_TRANSITIONS`：定义合法的状态流转规则
- 新增 `validateStateTransition(previousState, currentState)`：验证状态流转是否合法
- 增强回放逻辑：
  - 自动执行完整的证据链校验（可通过 `validateChain: false` 跳过）
  - 逐步骤验证状态流转合法性
  - 逐步骤验证哈希链完整性
  - 逐步骤重算并验证 `currentHash`
  - 生成 `stateReconstruction` 对象：包含初始状态、最终状态、所有转换记录
  - 生成 `validationIssues`：记录所有验证问题

**状态流转规则**：
```
null → pending → running → completed
                        ↘ failed → rolling_back → rolled_back
                        ↘ interrupted
                        ↘ timed_out
               ↘ interrupted
         running → paused → running
```

#### 问题5：operation manager 的证据记录要补业务关键字段摘要

**修复前**：`recordStateChangeEvidence` 只记录基本参数，缺少业务关键信息。

**修复后**：新增 `businessSummary` 字段，包含以下业务关键字段：
- `operationType`: 操作类型
- `dryRun`: 是否为试运行模式
- `autoRollbackOnFailure`: 失败时是否自动回滚
- `maxRetries`: 最大重试次数
- `retries`: 当前重试次数
- `timeoutMs`: 超时时间（毫秒）
- `concurrencyKey`: 并发控制键
- `maxConcurrency`: 最大并发数
- `progress`: 进度信息
- `createdAt`: 创建时间
- `startedAt`: 开始时间
- `completedAt`: 完成时间
- `failedAt`: 失败时间

#### 问题6：默认 check 脚本要纳入 evidence 新模块

**修复前**：`npm run check` 脚本未包含 evidence 相关文件。

**修复后**：更新 `package.json` 中的 `check` 脚本，新增以下文件检查：
- `src/routes/evidence.js`: 证据链 API 路由
- `src/routes/export-import.js`: 导出导入路由
- `src/services/evidence-chain-service.js`: 证据链核心服务
- `src/services/export-import-manager.js`: 导出导入管理器

### 增强的测试用例

新增以下测试用例覆盖修复的问题：

| 测试用例 | 覆盖场景 |
|---------|---------|
| `rebuildEvidenceCurrentHash recalculates hash correctly` | 验证哈希重算功能 |
| `validateEvidenceChainFull detects currentHash tampering` | 验证 currentHash 篡改检测 |
| `validateStateTransition validates state transitions` | 验证状态流转规则 |
| `replayOperationFromEvidence includes state reconstruction` | 验证回放包含状态重建 |
| `replayOperationFromEvidence detects invalid state transitions` | 验证回放检测非法状态流转 |
| `createEvidence includes business summary in parameters` | 验证业务摘要记录 |
| `listLogsSchema validates pagination parameters` | 验证分页参数校验 |

### 更新的响应格式

#### 回放响应（增强版）

```json
{
  "success": true,
  "operationId": "op_xxx",
  "operationType": "recovery",
  "dryRun": true,
  "finalState": "completed",
  "eventCount": 3,
  "canReplay": true,
  "message": "Dry run completed - no actual changes made",
  "validationIssues": [],
  "stateReconstruction": {
    "initialState": null,
    "finalState": "completed",
    "transitions": [
      { "step": 1, "from": null, "to": "pending", "valid": true },
      { "step": 2, "from": "pending", "to": "running", "valid": true },
      { "step": 3, "from": "running", "to": "completed", "valid": true }
    ],
    "valid": true
  },
  "replayLog": [
    {
      "step": 1,
      "evidenceId": "evid_xxx",
      "eventType": "operation_created",
      "targetState": "pending",
      "validation": {
        "step": 1,
        "evidenceId": "evid_xxx",
        "checks": [
          { "type": "state_transition", "valid": true, "from": null, "to": "pending" },
          { "type": "hash_chain", "valid": true },
          { "type": "current_hash", "valid": true }
        ]
      }
    }
  ]
}
```

#### 校验响应（增强版）

```json
{
  "ok": true,
  "operationId": "op_xxx",
  "valid": true,
  "issues": [],
  "warnings": [],
  "details": {
    "eventCount": 3,
    "validCount": 3,
    "invalidCount": 0,
    "hashValidation": {
      "attempted": 3,
      "valid": 3,
      "invalid": 0
    }
  }
}
```

### 错误类型与失败响应

#### 错误类型定义

证据链模块定义了以下错误类型：

| 错误类型 | 说明 | HTTP 状态码 |
|---------|------|------------|
| `chain_not_found` | 操作链不存在 | 404 |
| `evidence_not_found` | 证据不存在 | 404 |
| `validation_failed` | 通用验证失败 | 422 |
| `hash_tampered` | 哈希被篡改 | 422 |
| `chain_broken` | 哈希链断裂 | 422 |
| `timestamp_out_of_order` | 时间戳乱序 | 422 |
| `invalid_state_transition` | 非法状态流转 | 422 |
| `invalid_parameters` | 无效参数 | 422 |
| `evidence_disabled` | 证据链已禁用 | 503 |

#### 操作链不存在

**请求**：
```
GET /api/evidence/chains/nonexistent_op_123
```

**响应**（404）：
```json
{
  "ok": false,
  "message": "Operation chain not found",
  "details": {
    "errorType": "chain_not_found",
    "operationId": "nonexistent_op_123"
  }
}
```

#### 证据不存在

**请求**：
```
GET /api/evidence/logs/nonexistent_evid_123
```

**响应**（404）：
```json
{
  "ok": false,
  "message": "Evidence not found",
  "details": {
    "errorType": "evidence_not_found",
    "evidenceId": "nonexistent_evid_123"
  }
}
```

#### 参数校验失败

**请求**：
```
GET /api/evidence/logs?limit=0&offset=-1
```

**响应**（422）：
```json
{
  "ok": false,
  "message": "Validation failed",
  "details": {
    "errorType": "invalid_parameters",
    "issues": [
      {
        "field": "limit",
        "message": "Number must be greater than or equal to 1",
        "code": "too_small"
      },
      {
        "field": "offset",
        "message": "Number must be greater than or equal to 0",
        "code": "too_small"
      }
    ]
  }
}
```

#### 回放失败 - 链不存在

**请求**：
```
POST /api/evidence/replay/nonexistent_op_123
Content-Type: application/json

{
  "dryRun": true
}
```

**响应**（404）：
```json
{
  "ok": false,
  "message": "Operation chain not found",
  "details": {
    "errorType": "chain_not_found",
    "operationId": "nonexistent_op_123"
  }
}
```

#### 回放失败 - 哈希被篡改

**请求**：
```
POST /api/evidence/replay/op_tampered_001
Content-Type: application/json

{
  "dryRun": true
}
```

**响应**（200 OK，但 ok: false）：
```json
{
  "ok": false,
  "errorType": "hash_tampered",
  "errorMessage": "Evidence hash has been tampered",
  "operationId": "op_tampered_001",
  "operationType": "recovery",
  "canReplay": false,
  "validationIssues": [
    {
      "type": "hash_tampered",
      "severity": "error",
      "evidenceId": "evid_abc123def",
      "message": "Current hash does not match recalculated hash"
    }
  ],
  "context": {
    "totalIssues": 1,
    "primaryIssue": {
      "type": "hash_tampered",
      "severity": "error",
      "evidenceId": "evid_abc123def",
      "step": 2
    }
  }
}
```

#### 回放失败 - 哈希链断裂

**请求**：
```
POST /api/evidence/replay/op_broken_001
Content-Type: application/json

{
  "dryRun": true
}
```

**响应**（200 OK，但 ok: false）：
```json
{
  "ok": false,
  "errorType": "chain_broken",
  "errorMessage": "Hash chain link is broken",
  "operationId": "op_broken_001",
  "operationType": "import",
  "canReplay": false,
  "validationIssues": [
    {
      "type": "chain_broken",
      "severity": "error",
      "evidenceId": "evid_xyz789",
      "message": "Hash chain link is broken"
    }
  ],
  "context": {
    "totalIssues": 1,
    "primaryIssue": {
      "type": "chain_broken",
      "severity": "error",
      "evidenceId": "evid_xyz789",
      "step": 3
    }
  }
}
```

#### 回放失败 - 非法状态流转

**请求**：
```
POST /api/evidence/replay/op_invalid_state_001
Content-Type: application/json

{
  "dryRun": true
}
```

**响应**（200 OK，但 ok: false）：
```json
{
  "ok": false,
  "errorType": "invalid_state_transition",
  "errorMessage": "Invalid state transition from pending to completed",
  "operationId": "op_invalid_state_001",
  "operationType": "export",
  "canReplay": false,
  "validationIssues": [
    {
      "type": "invalid_state_transition",
      "severity": "error",
      "evidenceId": "evid_invalid_001",
      "message": "Invalid state transition from pending to completed"
    }
  ],
  "context": {
    "totalIssues": 1,
    "primaryIssue": {
      "type": "invalid_state_transition",
      "severity": "error",
      "evidenceId": "evid_invalid_001",
      "step": 2
    }
  }
}
```

#### 证据链禁用

**请求**：
```
GET /api/evidence/chains
```

**响应**（503）：
```json
{
  "ok": false,
  "message": "Evidence chain is disabled",
  "details": {
    "errorType": "evidence_disabled"
  }
}
```

### 校验失败示例

#### 完整校验 - 检测到哈希篡改

**请求**：
```
POST /api/evidence/chains/op_tampered_001/validate
```

**响应**：
```json
{
  "ok": true,
  "operationId": "op_tampered_001",
  "valid": false,
  "issues": [
    {
      "type": "hash_tampered",
      "severity": "error",
      "evidenceId": "evid_abc123def",
      "message": "Evidence evid_abc123def currentHash has been tampered"
    }
  ],
  "warnings": [],
  "details": {
    "eventCount": 3,
    "validCount": 2,
    "invalidCount": 1,
    "hashValidation": {
      "attempted": 3,
      "valid": 2,
      "invalid": 1
    }
  }
}
```

#### 完整校验 - 检测到链断裂

**请求**：
```
POST /api/evidence/chains/op_broken_001/validate
```

**响应**：
```json
{
  "ok": true,
  "operationId": "op_broken_001",
  "valid": false,
  "issues": [
    {
      "type": "chain_broken",
      "severity": "error",
      "evidenceId": "evid_xyz789",
      "message": "Hash chain broken at event 3 (prevHash mismatch)"
    }
  ],
  "warnings": [],
  "details": {
    "eventCount": 4,
    "validCount": 2,
    "invalidCount": 1,
    "hashValidation": {
      "attempted": 4,
      "valid": 4,
      "invalid": 0
    }
  }
}
```

#### 完整校验 - 检测到时间戳乱序

**请求**：
```
POST /api/evidence/chains/op_timestamp_001/validate
```

**响应**：
```json
{
  "ok": true,
  "operationId": "op_timestamp_001",
  "valid": false,
  "issues": [
    {
      "type": "timestamp_out_of_order",
      "severity": "error",
      "evidenceId": "evid_time_002",
      "message": "Event 2 timestamp 2026-05-02T09:00:00.000Z is earlier than previous event"
    }
  ],
  "warnings": [],
  "details": {
    "eventCount": 3,
    "validCount": 2,
    "invalidCount": 1,
    "hashValidation": {
      "attempted": 3,
      "valid": 3,
      "invalid": 0
    }
  }
}
```

#### 全链校验 - 返回失败链列表

**请求**：
```
POST /api/evidence/validate-all
```

**响应**：
```json
{
  "ok": true,
  "total": 5,
  "valid": 3,
  "invalid": 2,
  "failedChains": [
    {
      "operationId": "op_tampered_001",
      "operationType": "recovery",
      "issues": [
        {
          "type": "hash_tampered",
          "severity": "error",
          "evidenceId": "evid_abc123def",
          "message": "Evidence evid_abc123def currentHash has been tampered"
        }
      ]
    },
    {
      "operationId": "op_broken_001",
      "operationType": "import",
      "issues": [
        {
          "type": "chain_broken",
          "severity": "error",
          "evidenceId": "evid_xyz789",
          "message": "Hash chain broken at event 3 (prevHash mismatch)"
        }
      ]
    }
  ]
}
```

### 响应字段简化说明

为减少响应结构过重，部分接口返回字段已简化：

#### 链列表响应（简化）

**`GET /api/evidence/chains`** 返回简化的链对象，不再包含完整的 `events` 数组中的哈希字段：

```json
{
  "ok": true,
  "chains": [
    {
      "operationId": "op_xxx",
      "operationType": "recovery",
      "createdAt": "2026-05-02T10:00:00.000Z",
      "updatedAt": "2026-05-02T10:01:00.000Z",
      "lastEvidenceId": "evid_xxx",
      "lastHash": "abc123...",
      "eventCount": 3
    }
  ],
  "total": 42,
  "limit": 50,
  "offset": 0
}
```

#### 链详情响应（简化）

**`GET /api/evidence/chains/:operationId`** 返回简化的事件，只保留关键字段：

```json
{
  "ok": true,
  "operationId": "op_xxx",
  "chain": {
    "operationId": "op_xxx",
    "operationType": "recovery",
    "createdAt": "2026-05-02T10:00:00.000Z",
    "updatedAt": "2026-05-02T10:01:00.000Z",
    "lastEvidenceId": "evid_xxx",
    "lastHash": "abc123...",
    "events": [
      {
        "evidenceId": "evid_1",
        "eventType": "operation_created",
        "timestamp": "2026-05-02T10:00:00.000Z",
        "state": "pending",
        "previousState": null
      },
      {
        "evidenceId": "evid_2",
        "eventType": "operation_completed",
        "timestamp": "2026-05-02T10:01:00.000Z",
        "state": "completed",
        "previousState": "running"
      }
    ]
  },
  "evidences": [
    {
      "evidenceId": "evid_1",
      "operationType": "recovery",
      "operationId": "op_xxx",
      "eventType": "operation_created",
      "timestamp": "2026-05-02T10:00:00.000Z",
      "state": "pending",
      "previousState": null,
      "parameterDigest": "abc123...",
      "resultDigest": null,
      "errorDigest": null,
      "prevHash": "00000000...",
      "currentHash": "ffffffff..."
    }
  ]
}
```

#### 日志列表响应（简化）

**`GET /api/evidence/logs`** 返回简化的日志条目：

```json
{
  "ok": true,
  "logs": [
    {
      "evidenceId": "evid_xxx",
      "operationType": "recovery",
      "operationId": "op_xxx",
      "eventType": "operation_completed",
      "timestamp": "2026-05-02T10:01:00.000Z",
      "state": "completed",
      "previousState": "running"
    }
  ],
  "total": 150,
  "limit": 100,
  "offset": 0
}
```

#### 回放日志响应（简化）

**`POST /api/evidence/replay/:operationId`** 成功时返回简化的回放日志：

```json
{
  "ok": true,
  "operationId": "op_xxx",
  "operationType": "recovery",
  "dryRun": true,
  "finalState": "completed",
  "eventCount": 3,
  "replayLog": [
    {
      "step": 1,
      "evidenceId": "evid_1",
      "eventType": "operation_created",
      "targetState": "pending",
      "previousState": null
    },
    {
      "step": 2,
      "evidenceId": "evid_2",
      "eventType": "operation_started",
      "targetState": "running",
      "previousState": "pending"
    },
    {
      "step": 3,
      "evidenceId": "evid_3",
      "eventType": "operation_completed",
      "targetState": "completed",
      "previousState": "running"
    }
  ],
  "message": "Dry run completed - no actual changes made"
}
```

### 业务摘要按操作类型整理

证据记录中的 `businessSummary` 现在按操作类型进行分类整理：

#### Recovery 操作

```json
{
  "operationType": "recovery",
  "dryRun": true,
  "autoRollbackOnFailure": true,
  "maxRetries": 0,
  "retries": 0,
  "timeoutMs": 300000,
  "concurrencyKey": "recovery",
  "maxConcurrency": 1,
  "progress": { ... },
  "createdAt": "2026-05-02T10:00:00.000Z",
  "startedAt": "2026-05-02T10:00:01.000Z",
  "completedAt": "2026-05-02T10:00:30.000Z",
  "failedAt": null,
  "operationSpecific": {
    "recovery": {
      "createBackup": true,
      "quarantineCorrupted": true,
      "enableTransaction": true,
      "logFilePath": null,
      "trackedResources": ["sessions", "events_log", "leaderboard"]
    }
  }
}
```

#### Import 操作

```json
{
  "operationType": "import",
  "dryRun": false,
  "autoRollbackOnFailure": true,
  "maxRetries": 1,
  "retries": 0,
  "timeoutMs": 600000,
  "concurrencyKey": "import",
  "maxConcurrency": 1,
  "progress": { ... },
  "createdAt": "2026-05-02T10:00:00.000Z",
  "startedAt": null,
  "completedAt": null,
  "failedAt": null,
  "operationSpecific": {
    "import": {
      "mergeStrategy": "skip_existing",
      "skipExisting": false,
      "overwriteExisting": false,
      "validateBeforeImport": true,
      "targetSessionIds": null,
      "importSource": null,
      "trackedResources": ["sessions", "events_log", "leaderboard"]
    }
  }
}
```

#### Export 操作

```json
{
  "operationType": "export",
  "dryRun": false,
  "autoRollbackOnFailure": false,
  "maxRetries": 1,
  "retries": 0,
  "timeoutMs": 300000,
  "concurrencyKey": "export",
  "maxConcurrency": 1,
  "progress": { ... },
  "createdAt": "2026-05-02T10:00:00.000Z",
  "startedAt": null,
  "completedAt": null,
  "failedAt": null,
  "operationSpecific": {
    "export": {
      "exportFormat": "json",
      "includeSessions": true,
      "includeEvents": true,
      "includeLeaderboard": true,
      "targetSessionIds": null,
      "compressionEnabled": false,
      "exportDestination": null
    }
  }
}
```

#### Restore 操作

```json
{
  "operationType": "restore",
  "dryRun": false,
  "autoRollbackOnFailure": true,
  "maxRetries": 1,
  "retries": 0,
  "timeoutMs": 300000,
  "concurrencyKey": "restore",
  "maxConcurrency": 1,
  "progress": { ... },
  "createdAt": "2026-05-02T10:00:00.000Z",
  "startedAt": null,
  "completedAt": null,
  "failedAt": null,
  "operationSpecific": {
    "restore": {
      "backupId": null,
      "restorePoint": null,
      "includeSessions": true,
      "includeEvents": true,
      "includeLeaderboard": true,
      "createBackupBeforeRestore": true
    }
  }
}
```

#### Delete 操作

```json
{
  "operationType": "delete",
  "dryRun": true,
  "autoRollbackOnFailure": false,
  "maxRetries": 1,
  "retries": 0,
  "timeoutMs": 60000,
  "concurrencyKey": "delete",
  "maxConcurrency": 1,
  "progress": { ... },
  "createdAt": "2026-05-02T10:00:00.000Z",
  "startedAt": null,
  "completedAt": null,
  "failedAt": null,
  "operationSpecific": {
    "delete": {
      "deleteType": "session",
      "targetSessionIds": null,
      "deleteAll": false,
      "includeBackup": false,
      "createBackupBeforeDelete": true,
      "affectedResources": null
    }
  }
}
```
