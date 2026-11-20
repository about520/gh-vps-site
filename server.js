/**
 * gh-vps-deployer
 * 访客提交自己的 GitHub PAT，服务端代他：
 *   1. 验证密钥
 *   2. 建一个 public 仓库（public 仓库的 Actions 分钟数无限）
 *   3. 写入 Windows workflow
 *   4. 触发 workflow_dispatch
 *   5. 轮询仓库里的 status.md，拿到 RDP 地址和密码
 *   6. 返回给前端
 *
 * 密钥只在内存里用，不落库、不写日志、任务结束即丢弃。
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/** 任务表：内存存储，进程重启即清空 */
const tasks = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 统一封装 GitHub API 调用 */
async function gh(token, method, apiPath, body) {
  const res = await fetch('https://api.github.com' + apiPath, {
    method,
    headers: {
      Authorization: 'token ' + token,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'gh-vps-deployer',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 500) };
    }
  }
  return { status: res.status, data };
}

/** 从 status.md 里解析连接信息 */
function parseStatus(md) {
  const addr = md.match(/bore\.pub:\d+/);
  if (!addr) return null;
  // 格式里字段和值可能被换行拆开，用宽松匹配
  const pw =
    (md.match(/密码[:：]\s*\n?\s*([A-Za-z0-9!@#$%^&*._-]+)/) || [])[1] || 'Runner2024';
  const user =
    (md.match(/用户名\(简写\)[:：]\s*\n?\s*(\S+)/) || [])[1] || '.\\runneradmin';
  const userFull =
    (md.match(/用户名[:：]\s*\n?\s*(\S+)/) || [])[1] || user;
  const rdpOk = /RDP 服务[:：]\s*\n?\s*Running/.test(md);
  const pwOk = /实测通过[:：]\s*\n?\s*是/.test(md);
  return { address: addr[0], password: pw, username: user, usernameFull: userFull, rdpOk, pwOk };
}

/** 主流程 */
async function runDeploy(task, token, minutes) {
  const log = (s) => {
    task.step = s;
    task.logs.push({ t: Date.now(), s });
    if (task.logs.length > 60) task.logs.shift();
  };

  // 1. 验证密钥
  log('验证 GitHub 密钥');
  let r = await gh(token, 'GET', '/user');
  if (r.status !== 200) {
    throw new Error('密钥无效或已过期（HTTP ' + r.status + '）');
  }
  task.owner = r.data.login;
  log('已登录：' + r.data.login);

  // 2. 建仓库
  log('创建仓库');
  const repoName = 'gh-vps-' + crypto.randomBytes(3).toString('hex');
  r = await gh(token, 'POST', '/user/repos', {
    name: repoName,
    private: false, // public 才有无限 Actions 分钟数
    auto_init: true,
    description: 'gh-vps auto deploy',
  });
  if (r.status !== 201) {
    throw new Error('建仓库失败：' + (r.data.message || r.status));
  }
  task.repo = r.data.full_name;
  log('仓库已建：' + task.repo);

  // 3. 写 workflow
  log('写入部署脚本');
  const wfPath = path.join(__dirname, 'workflow', 'win.yml');
  const wfContent = fs.readFileSync(wfPath, 'utf8');
  r = await gh(token, 'PUT', `/repos/${task.repo}/contents/.github/workflows/win.yml`, {
    message: 'ci: add windows vps workflow',
    content: Buffer.from(wfContent).toString('base64'),
    branch: 'main',
  });
  if (r.status !== 200 && r.status !== 201) {
    throw new Error('写脚本失败：' + (r.data.message || r.status));
  }
  log('脚本已推送');

  // 4. 等 GitHub 索引新 workflow
  log('等待 GitHub 索引（约 6 秒）');
  await sleep(6000);

  // 5. 触发
  log('启动机器');
  r = await gh(token, 'POST', `/repos/${task.repo}/actions/workflows/win.yml/dispatches`, {
    ref: 'main',
    inputs: { minutes: String(minutes) },
  });
  if (r.status !== 204) {
    throw new Error('启动失败：' + (r.data.message || r.status) + '（密钥需要 workflow 权限）');
  }
  log('已触发，机器开机中');

  // 6. 轮询 status.md
  log('等待机器回写地址');
  const deadline = Date.now() + 12 * 60 * 1000;
  let lastRaw = '';
  let lastRunChecked = 0;

  while (Date.now() < deadline) {
    await sleep(6000);
    r = await gh(token, 'GET', `/repos/${task.repo}/contents/status.md`);
    if (r.status === 200 && r.data.content) {
      const txt = Buffer.from(r.data.content, 'base64').toString('utf8');
      lastRaw = txt;
      const info = parseStatus(txt);
      if (info) {
        log('机器已就绪');
        task.status = 'done';
        task.result = { ...info, repo: task.repo, raw: txt };
        return;
      }
    }

    // 每 3 次顺手看一眼运行状态，失败就早退
    if (Date.now() - lastRunChecked > 20000) {
      lastRunChecked = Date.now();
      const rr = await gh(token, 'GET', `/repos/${task.repo}/actions/runs?per_page=1`);
      const run = rr.data?.workflow_runs?.[0];
      if (run && run.status === 'completed' && run.conclusion !== 'success') {
        throw new Error('工作流结束但失败：' + run.conclusion + '，日志 ' + run.html_url);
      }
    }
  }

  throw new Error('等待超时（12 分钟）。最后内容：' + lastRaw.slice(0, 200));
}

/** 提交部署 */
app.post('/api/deploy', (req, res) => {
  const { token, minutes } = req.body || {};

  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: '缺少密钥' });
  }
  if (!/^(ghp_|github_pat_)/.test(token.trim())) {
    return res.status(400).json({ error: '密钥格式不对，应该以 ghp_ 或 github_pat_ 开头' });
  }

  // 同一时间只允许一个进行中的任务（防止同一个 IP 刷）
  for (const t of tasks.values()) {
    if (t.status === 'running' && Date.now() - t.createdAt < 15 * 60 * 1000) {
      // 不阻止，只记录；如果需要限流改成 return 429
    }
  }

  const id = crypto.randomUUID();
  const task = {
    id,
    status: 'running',
    step: '准备中',
    logs: [],
    result: null,
    error: null,
    createdAt: Date.now(),
  };
  tasks.set(id, task);

  const mins = Math.min(Math.max(Number(minutes) || 350, 30), 350);

  runDeploy(task, token.trim(), mins)
    .catch((e) => {
      task.status = 'error';
      task.step = '失败';
      task.error = e.message;
      task.logs.push({ t: Date.now(), s: '❌ ' + e.message });
    })
    .finally(() => {
      // 密钥不保留
      task.token = undefined;
    });

  res.json({ id });
});

/** 查询任务 */
app.get('/api/task/:id', (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) {
    return res.status(404).json({ error: '任务不存在或已过期' });
  }
  res.json({
    id: t.id,
    status: t.status,
    step: t.step,
    logs: t.logs.slice(-15),
    result: t.result,
    error: t.error,
    elapsed: Math.floor((Date.now() - t.createdAt) / 1000),
  });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, tasks: tasks.size, uptime: process.uptime() });
});

/** 每小时清一次过期任务 */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tasks) {
    if (now - v.createdAt > 60 * 60 * 1000) tasks.delete(k);
  }
}, 10 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`gh-vps-deployer 已启动: http://localhost:${PORT}`);
});
