# 🔭 业余天文台观测夜排程

输入观测地经纬度、UTC 观测时间窗（有序、最长 12 小时）、换台间隔与观测目标列表，
自动求解使 **优先级总和最大 → 排入数量最多 → 编号/开始时刻序列字典序最小**
的整分钟观测计划。Node.js（无框架 HTTP）+ SQLite + 浏览器单页。

## 功能要点

- **输入**
  - 观测点纬度 `[-90, 90]`、经度 `[-180, 180]`（十进制度，北纬/东经为正）
  - UTC 起止时间窗：结束晚于开始、时长 ≤ 720 分钟（12 小时）
  - 换台间隔：非负整数分钟（相邻曝光之间必须留足）
  - 至多 16 个目标：编号（正整数、唯一）、赤经 `[0,360)`°、赤纬 `[-90,90]`°、
    曝光分钟（正整数）、最低高度角 `[-90,90]`°、优先级（正整数）
  - 任意目标可指定 **锁定时刻**：必须落在整分钟（秒为 00）
- **硬性约束**
  - 每个目标至多排一次；曝光只在整分钟开始，且全程处于时间窗内
  - 曝光全程（不是仅开始/结束时刻）高度角 ≥ 最低高度角
  - 相邻曝光（含锁定项之间、锁定项与自动项之间）间隔 ≥ 换台分钟
- **锁定拒绝规则（整次拒绝并指出目标）**
  - 锁定时刻非整分钟、曝光超出时间窗、目标在该时刻不可见
  - 两个锁定曝光间隔不足换台时间（同时指出冲突的两个编号）
- **优化目标（依次）**
  1. 排入目标优先级总和最大
  2. 排入目标数最多
  3. 同分取按开始顺序排列的「目标编号序列」字典序最小
  4. 仍同分取「开始时刻序列」（相对窗起点整分钟数）字典序最小
- **输出**
  - UTC 排程表：开始/结束时刻、时长、优先级、全程最低高度角、是否锁定
  - 时间线图（紫色为锁定项，虚线为换台间隙）
  - 未入选目标逐个给出原因：`不可见` 或 `容量不足`（含详细说明）
- 非法参数（坐标越界、时间窗非法、字段类型错误等）返回 400 并逐字段列出
- 每次排程持久化到 SQLite，可通过历史接口查询

## 快速启动（Docker Compose，一键）

需要安装 Docker（含 Compose 插件）。

```bash
docker compose up --build -d
```

首次会自动完成：安装依赖 → 建库（SQLite 表自动创建于命名卷）→ 启动服务。

浏览器打开：

```
http://localhost:8080
```

停止 / 查看日志：

```bash
docker compose down          # 停止（数据保留在命名卷）
docker compose logs -f       # 跟踪日志
```

## 仅用 Docker 运行

```bash
docker build -t observatory-scheduler .
docker run -d --name obs-sched -p 8080:8080 \
  -v obs-sched-data:/app/data observatory-scheduler
```

## 本地（无 Docker）运行

要求 Node.js 20+。

```bash
npm ci              # 或 npm install
npm start           # 启动，默认 http://localhost:8080
```

排程核心自测（不依赖网络与数据库）：

```bash
npm run selftest
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 服务监听端口 |
| `DB_PATH` | `./data/scheduler.db`（容器内 `/app/data/scheduler.db`） | SQLite 数据库文件路径，目录自动创建 |

修改宿主机映射端口（例如改用 9000）：编辑 `docker-compose.yml` 中
`ports: ["9000:8080"]`（左侧为宿主机端口），或直接：

```bash
PORT=9000 npm start
```

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/schedule` | 提交排程，body 为 JSON |
| `GET` | `/api/schedules` | 最近 50 条排程记录摘要 |
| `GET` | `/api/schedules/:id` | 读取某次完整排程结果 |
| `GET` | `/api/health` | 健康检查 |

请求示例：

```json
{
  "latitude": 39.9042,
  "longitude": 116.4074,
  "startUtc": "2026-10-04T22:00:00Z",
  "endUtc": "2026-10-05T06:00:00Z",
  "slewMin": 10,
  "targets": [
    { "id": 1, "ra": 140.0, "dec": -5.39, "expMin": 25, "minAlt": 25, "priority": 3 },
    { "id": 2, "ra": 299.30, "dec": 22.72, "expMin": 30, "minAlt": 25, "priority": 2,
      "lockAt": "2026-10-05T00:00:00Z" }
  ]
}
```

- 时间统一使用带 `Z`（或 `±HH:MM` 偏移）的 UTC ISO 8601；**不带时区的日期时间会被拒绝**。
- 不需要锁定时省略 `lockAt` 或传 `null`。
- 参数/锁定错误返回 HTTP 400，body 形如：
  - `{"ok":false,"errors":[{"field":"latitude","message":"..."}]}`
  - `{"ok":false,"lockViolations":[{"id":2,"reason":"不可见","detail":"..."}]}`
    或 `{"targets":[2,5],"reason":"锁定冲突","detail":"..."}`

## 页面使用

1. 在「① 观测参数」填写经纬度（页面把无时区的日期选择器显式按 UTC 解释）、
   UTC 时间窗与换台分钟；页面会实时显示窗口时长与上限校验。
2. 在「② 观测目标」逐行填写，可勾选每行的锁定时刻；点击「载入示例」预填。
3. 点击「生成排程」：成功时展示时间线、UTC 排程表和未入选原因；
   失败时红色面板列出全部非法字段或锁定冲突目标。

## 实现说明

- `src/astro.js`：Julian Date / GMST（Meeus 平恒星时公式）/ 地方恒星时 / 高度角。
- `src/visibility.js`：把一次曝光视为连续的小时角弧线，解析判断弧上高度角始终达标的
  允许区间，逐整分钟生成可行位图（无数值采样漏判风险）。
- `src/scheduler.js`：参数与锁定校验；在「剩余目标位掩码 × 当前游标分钟」状态上做
  记忆化动态规划，自动目标只尝试其最早可行开始（再晚只会更差），并可空转越过锁定块；
  第二遍记忆化重建负责按字典序取出唯一最优方案。
- `src/db.js` / `src/server.js`：SQLite 持久化（better-sqlite3，WAL）与原生 HTTP 服务。
- `public/`：无依赖原生 HTML/CSS/JS 单页。

## 目录结构

```
Dockerfile  docker-compose.yml  package.json
src/        astro.js  visibility.js  scheduler.js  db.js  server.js
public/     index.html  styles.css  app.js
test/       selftest.js
data/       （运行后生成，SQLite 数据库；容器内为命名卷）
```
