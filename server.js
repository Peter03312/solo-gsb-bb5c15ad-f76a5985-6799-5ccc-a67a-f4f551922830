'use strict';

const path = require('path');
const express = require('express');
const { planFromBody } = require('./src/scheduler');
const { insertRun, listRuns, getRun } = require('./src/db');

const PORT = Number(process.env.PORT) || 8080;

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'observatory-night-scheduler' });
});

/** 提交一次观测夜排程 */
app.post('/api/schedule', (req, res) => {
  try {
    const result = planFromBody(req.body);
    const runId = insertRun(req.body, 'ok', result);
    res.json({ ok: true, runId, ...result });
  } catch (e) {
    if (e && e.status) {
      const result = { error: e.message, code: e.code, targets: e.targets || [] };
      insertRun(req.body, 'rejected', result);
      res.status(e.status).json({ ok: false, ...result });
    } else {
      console.error('排程内部错误:', e);
      res.status(500).json({ ok: false, error: '服务器内部错误' });
    }
  }
});

/** 历史记录列表 */
app.get('/api/runs', (req, res) => {
  res.json({ ok: true, runs: listRuns(req.query.limit) });
});

/** 单条历史记录详情 */
app.get('/api/runs/:id', (req, res) => {
  const run = getRun(Number(req.params.id));
  if (!run) {
    res.status(404).json({ ok: false, error: '记录不存在' });
    return;
  }
  res.json({ ok: true, run });
});

app.listen(PORT, () => {
  console.log(`观测夜排程服务已启动: http://localhost:${PORT}`);
});
