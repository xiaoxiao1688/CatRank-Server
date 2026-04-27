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

## 推荐接口

### `POST /api/sessions`

创建会话。

请求：

```json
{
  "playerName": "Guest Cat"
}
```

响应：

```json
{
  "ok": true,
  "sessionId": "sess_xxx",
  "state": "created"
}
```

### `POST /api/sessions/:sessionId/start`

启动会话。

响应：

```json
{
  "ok": true,
  "state": "playing",
  "startedAt": "2026-04-27T00:00:00.000Z"
}
```

### `POST /api/sessions/:sessionId/events`

追加事件。

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

响应：

```json
{
  "ok": true,
  "accepted": true,
  "eventId": "evt_xxx"
}
```

### `POST /api/sessions/:sessionId/finish`

结束并结算。

响应：

```json
{
  "ok": true,
  "state": "finished",
  "result": {
    "score": 180,
    "summary": {
      "fishCaught": 10,
      "goldenFishCaught": 2,
      "bombHit": 1,
      "enemyDefeated": 3
    }
  }
}
```

### `POST /api/sessions/:sessionId/close`

主动关闭不入榜会话。

### `GET /api/leaderboard?page=1&pageSize=20`

分页查询排行榜。

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
      "playerName": "Guest Cat",
      "score": 180,
      "createdAt": "2026-04-27T00:00:00.000Z"
    }
  ]
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
  "scoreSubmitted": false,
  "events": [],
  "result": null
}
```

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
