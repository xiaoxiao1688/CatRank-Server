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
