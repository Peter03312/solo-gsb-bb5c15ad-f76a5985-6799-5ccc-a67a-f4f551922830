# 业余天文台观测夜排程（Observatory Night Scheduler）

基于 **Node.js + Express + SQLite（better-sqlite3）+ 原生浏览器页面** 的观测夜排程 Web 应用。
输入测站经纬度、UTC 时间窗、换台时长与至多 16 个观测目标，自动求出满足全部约束的最优排程，
并在页面展示 UTC 排程表与未入选目标的原因。

## 功能与规则

**输入**

| 字段 | 约束 |
| --- | --- |
| 纬度 / 经度 | 度；纬度 ∈ [-90, 90]，经度 ∈ [-180, 180]，东经/北纬为正 |
| 时间窗开始 / 结束 | UTC（ISO 8601）；开始必须早于结束，时长 ≤ 12 小时 |
| 换台时间 | 非负整数分钟 |
| 目标（≤ 16 个） | 编号（唯一）、赤经 ∈ [0, 360)°、赤纬 ∈ [-90, 90]°、曝光分钟（正整数）、最低高度角 ∈ [-90, 90]°、优先级（正整数）、可选锁定开始（UTC 整分钟） |

**排程规则**

- 每个目标至多排入一次；所有曝光在**整分钟**开始。
- 每段曝光全程位于时间窗内，且全程高度角 ≥ 该目标最低高度角（按 GMST 解析计算区间最小高度，含下中天穿越）。
- 相邻曝光之间（含与锁定目标之间）留足换台间隔。
- **锁定目标**：若锁定时段不可见 / 超出时间窗，或锁定项之间（含换台间隔）互相冲突，则**整次拒绝**并在响应中指出涉及目标。
- 优化目标（字典序依次）：① 排入目标**优先级总和最大**；② 同分时**排入目标数最多**；③ 同分时按开始顺序的
  **（目标编号序列, 开始时刻序列）字典序最小**（编号均为数值时按数值比较，否则按字符串比较）。
- 未入选目标给出原因：**不可见**（窗内不存在满足高度角的完整曝光时段）或**容量不足**（可见但排不下）。
- 非法坐标、非法时长、非法时间窗（无序 / 超 12 小时 / 不可解析）等一律拒绝（HTTP 400）。

**持久化**：每次请求（含被拒绝的）连同结果写入 SQLite，页面可浏览历史记录。

## 快速开始（Docker，推荐）

```bash
docker compose up --build
```

然后访问 **http://localhost:8080** 。

也可以分步执行：

```bash
docker build -t observatory-night-scheduler .
docker run -d -p 8080:8080 -v observatory-data:/app/data observatory-night-scheduler
```

## 本地开发（不用 Docker）

```bash
npm install
npm start          # 启动服务，默认 http://localhost:8080
npm test           # 运行测试（node:test，24 个用例）
```

## 配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP 监听端口（页面与 API 同端口） |
| `DB_PATH` | 容器内 `/app/data/observatory.db`；本地 `data/observatory.db` | SQLite 数据库文件路径 |

Compose 中通过命名卷 `observatory-data` 持久化数据库；改端口可修改 `docker-compose.yml` 的 `ports` 映射。

## 页面与 API

- 页面地址：**http://localhost:8080/** （输入表单、排程结果、未入选原因、历史记录）
- `POST /api/schedule`：提交排程。请求体示例：

```json
{
  "latitude": 40.0,
  "longitude": 116.4,
  "windowStart": "2026-10-04T13:00:00Z",
  "windowEnd": "2026-10-04T21:00:00Z",
  "slewMinutes": 5,
  "targets": [
    {"id": "M31", "ra": 10.68, "dec": 41.27, "exposureMinutes": 40, "minAltitude": 25, "priority": 8},
    {"id": "M81", "ra": 148.89, "dec": 69.07, "exposureMinutes": 30, "minAltitude": 15, "priority": 7,
     "lockStart": "2026-10-04T15:00:00Z"}
  ]
}
```

  - 成功 `200`：`{ ok, runId, schedule: [{id, start, end, locked, priority}], unscheduled: [{id, reason, message}], totalPriority, scheduledCount }`
  - 拒绝 `400`：`{ ok: false, error, code: VALIDATION_ERROR | LOCKED_CONFLICT, targets: [...] }`
- `GET /api/runs`：历史记录列表；`GET /api/runs/:id`：单条详情；`GET /api/health`：健康检查。

## 实现要点

- **天文计算**（`src/astro.js`）：GMST 近似 → 时角 → 高度角；区间最小高度取端点与下中天（H=180°）处的解析最小值，O(1) 精确判定“曝光全程不低于阈值”。
- **排程优化**（`src/scheduler.js`）：时间窗 ≤ 12h 离散为 ≤ 720 个整分钟；每个目标预处理“不早于 t 的最早可行起点”表（含可见性与锁定占用避让）；子集 DP（2^16）求可行子集的最小结束时刻，得最优（优先级和, 数量）；再用带完备性预言机的贪心重构出编号序列与开始时刻字典序最小的方案（锁定目标作为固定时刻元素参与序列比较）。
- **存储**（`src/db.js`）：better-sqlite3，WAL 模式，表 `runs(id, created_at, status, request_json, result_json)`。

## 项目结构

```
├── server.js            # Express 入口与路由
├── src/
│   ├── astro.js         # 高度角 / 区间最小高度计算
│   ├── scheduler.js     # 校验 + 排程优化核心
│   └── db.js            # SQLite 持久化
├── public/index.html    # 单文件前端页面
├── test/scheduler.test.js
├── Dockerfile           # 多阶段构建（依赖编译 + 精简运行镜像）
├── docker-compose.yml   # 一键启动
└── README.md
```
