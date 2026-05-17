# 微信好友可用的五子棋

一个可以分享链接对战的五子棋小游戏。前端使用 React + Vite，服务端使用 Express + Socket.IO。本地可以自己试玩，部署到 Railway 后可以把 HTTPS 链接发给微信好友。

## 本地启动

```bash
npm install
npm run dev
```

默认地址：

```text
http://localhost:3000
```

## 部署到 Railway 后分享给微信好友

Railway 会读取项目里的 `railway.json`：

- Build Command: `npm install && npm run build`
- Start Command: `npm run start`
- Healthcheck Path: `/health`

部署完成后，Railway 会给你一个类似这样的 HTTPS 地址：

```text
https://你的项目名.up.railway.app
```

打开这个地址，创建房间，然后把页面里的房间链接发给微信好友。链接会像这样：

```text
https://你的项目名.up.railway.app?room=房间号
```

注意：微信好友不能使用 `localhost` 或局域网 IP，必须使用 Railway 生成的 HTTPS 公网地址。

## Railway 小白步骤

1. 把项目推送到 GitHub。
2. 打开 Railway，选择 New Project。
3. 选择 Deploy from GitHub repo。
4. 选择这个五子棋仓库。
5. Variables 里添加：`NODE_ENV=production`。
6. Settings 里确认实例数量为 1 个。
7. 生成 Public Networking 的 Railway Domain。
8. 打开域名，创建房间并复制链接发给微信好友。

## 规则

- 15x15 棋盘。
- 黑棋先手，双方轮流落子。
- 横、竖、斜任意五连获胜。
- 每个房间最多 2 名玩家，其他人进入后自动观战。
- 支持重开、悔棋请求、离线暂停和观战同步。

## 生产构建

```bash
npm run build
npm run start
```

## 健康检查

```text
http://localhost:3000/health
```

Railway 部署后对应为：

```text
https://你的项目名.up.railway.app/health
```
