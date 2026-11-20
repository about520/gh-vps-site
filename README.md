# gh-vps-deployer

> 输入一个 GitHub 密钥，自动在 GitHub Actions 上开一台 Windows Server 2025（4 核 16G），
> 拿到 RDP 地址和密码，用 `mstsc` 直接连。

## 它到底做了什么

访客在网页上填自己的 GitHub Personal Access Token，后端就代他完成这套动作：

```
验证 token  →  建 public 仓库  →  推送 workflow  →  workflow_dispatch 触发
                                                        ↓
              返回 RDP 地址  ←  解析 status.md  ←  机器把连接信息写回仓库文件
```

全程用的是**访客自己的账号和额度**，你的服务器只做个转发指挥。

## 快速开始

```bash
npm install
npm start
# 打开 http://localhost:3000
```

浏览器里填一个 PAT（勾选 `repo` + `workflow`），点「开始部署」，等 60~120 秒。

## 密钥怎么拿

直接点页面上的「一键生成」链接，或者手搓：

1. https://github.com/settings/tokens/new
2. Note 随便写
3. Expiration 选 30 天
4. **勾选 `repo` 和 `workflow`**（缺 workflow 会触发失败）
5. Generate token，复制 `ghp_` 开头那串

## 部署到公网

### 方式 A：Docker（推荐，任何 VPS 都行）

```bash
docker build -t gh-vps .
docker run -d --name gh-vps -p 3000:3000 --restart unless-stopped gh-vps
```

配个 Nginx 反代 + HTTPS 就能对外了：

```nginx
server {
    listen 443 ssl http2;
    server_name vps.yourdomain.com;
    ssl_certificate     /etc/letsencrypt/live/vps.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/vps.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 900s;
    }
}
```

### 方式 B：Render / Railway / Fly.io

- Build Command: `npm install`
- Start Command: `npm start`
- 环境变量：`PORT` 一般平台会自己注入

这三个平台都有免费额度，够跑这个轻量服务。

### 方式 C：Vercel

需要把 `server.js` 改成 `api/` 目录下的 serverless 函数，且任务状态不能放内存（要换 Redis / KV）。
如果只是自己用，方式 A / B 更省事。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |

## API

### `POST /api/deploy`

```json
{ "token": "ghp_xxx", "minutes": 350 }
```

返回：

```json
{ "id": "任务 uuid" }
```

### `GET /api/task/:id`

```json
{
  "status": "running | done | error",
  "step": "当前步骤",
  "logs": [{ "t": 1700000000, "s": "创建仓库" }],
  "result": {
    "address": "bore.pub:27287",
    "username": ".\\runneradmin",
    "usernameFull": "runnervmm7ud1\\runneradmin",
    "password": "Runner2024",
    "rdpOk": true,
    "pwOk": true,
    "repo": "about520/gh-vps-a1b2c3"
  },
  "error": null,
  "elapsed": 87
}
```

### `GET /api/health`

```json
{ "ok": true, "tasks": 1, "uptime": 123.4 }
```

## 底层 workflow 说明

`workflow/win.yml` 就是在 GitHub Actions 上跑的那套东西，核心几步：

1. `Set-LocalUser` 设密码，并用 `ValidateCredentials` **实测**，只把真能登录的密码写进 `status.md`
2. 开 RDP（`fDenyTSConnections=0`、关 NLA、开防火墙、起 TermService）
3. 下载 `bore.exe`，`bore local 3389 --to bore.pub` 打一条 TCP 隧道
4. 把地址和密码用 GitHub Contents API 写回仓库的 `status.md`
5. 每 60 秒检查 bore 进程，挂了自动重连并更新地址

### 为什么不用 tmate

`tmate.io` 的官方服务器已经不在线了（`ssh.tmate.io` 返回 NXDOMAIN），
`action-tmate` 现在在任何平台上都连不上。所以这里换成 bore。

### 为什么用 public 仓库

public 仓库的 Actions 分钟数**不限**，private 仓库只有 2000 分钟/月（Windows 还要 2 倍系数）。
代价是 `status.md` 里的地址密码对所有人可见，介意的话：

- 把 `win.yml` 里的密码改成从 `secrets` 读
- 或者把仓库建为 private（`server.js` 里 `private: false` 改 `true`）

## 安全说明

- 密钥只在请求内存里用，**不落库、不写日志**
- 任务记录 1 小时后自动清理
- 建议在公网部署时加一层访问控制（Basic Auth / Cloudflare Access），避免被人当免费代部署接口刷

## 目录结构

```
gh-vps/
├── server.js              # 后端：GitHub API 编排
├── package.json
├── workflow/
│   └── win.yml            # 推到访客仓库里的 workflow 模板
├── public/
│   └── index.html         # 前端单页
├── Dockerfile
└── README.md
```

## 已知限制

- **bore.pub 是公共中继**，延迟 300~1000ms，RDP 会有点跟手感。要更顺可以换 ngrok（填 authtoken）或自建 frp
- 单次最长 **6 小时**，这是 GitHub Actions 的硬上限
- 机器销毁后磁盘不保留，数据要自己传走
- 同一个 GitHub 账号并发跑多个 job 会排队（取决于账号额度）

## 许可

MIT
