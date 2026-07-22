# AeroDrop

轻量级 WebRTC 文件传输与屏幕共享应用。默认优先端对端（P2P），不可达时回退 TURN 中继。

## Features

- 文件传输：4 位口令 / 分享链接连接，支持多文件与文件夹
- 屏幕共享：跨设备实时观看
- 跨平台：现代浏览器即开即用
- 安全：数据不经业务服务器落盘

## Connection Modes

- `直连`：同内网或可直接互通，通常最快  
- `点对点`：跨网络 P2P，速度通常优于中继  
- `中继（速度会变慢）`：TURN 转发，成功率更高

## Quick Start

```bash
npm install
npm run dev
npm run dev:worker
```

Build:

```bash
npm run build
```

## Deploy

Cloudflare Worker:

```bash
npm run deploy
```

## Signaling

项目已从 PeerJS 默认信令迁移为 **Cloudflare Worker + Durable Object + WebSocket** 自管信令。

生产环境下前端默认连接当前站点同源的：

- `wss://<your-domain>/ws-signaling`

Worker 会把该 WebSocket 请求转发到 `SignalingHub` Durable Object，由它负责：

- 注册 `peerId`
- 拒绝重复口令
- 转发 `offer / answer / ice-candidate`

本地开发建议同时启动：

```bash
npm run dev
npm run dev:worker
```

其中：

- Vite 默认在 `http://127.0.0.1:3000`
- Wrangler 默认在 `http://127.0.0.1:8787`
- `vite.config.ts` 已代理 `/api` 和 `/ws-signaling` 到本地 Worker

可选前端环境变量：

- `VITE_SIGNALING_WS_URL`
- `VITE_SIGNALING_BASE_URL`
- `VITE_SIGNALING_PATH`

## TURN Configuration (Recommended)

可配置自管 coturn 作为 Cloudflare TURN 不可用时的后备。Worker 使用 TURN REST HMAC-SHA1 生成短期凭证：

- `TURN_URLS`：逗号或换行分隔的 `turn:` / `turns:` 地址
- `TURN_SHARED_SECRET`：coturn `static-auth-secret`，必须保存为 Worker Secret
- `TURN_REALM`：与 coturn `realm` 保持一致
- `TURN_TTL_SECONDS`：可选，默认 `3600`，有效范围 `60`–`86400`

示例：

```bash
npx wrangler secret put TURN_SHARED_SECRET
```

生产默认优先使用 Cloudflare 官方 TURN 短期凭证模式：

- `CF_TURN_TOKEN_ID`
- `CF_TURN_API_TOKEN`
- `CF_TURN_TTL_SECONDS` 可选，默认 `3600`

注意：

- 如果这些值是在 Cloudflare Dashboard 里手动添加的，`wrangler deploy` 默认会以下发配置为准覆盖远端变量。
- 本项目已在 [`wrangler.jsonc`](./wrangler.jsonc) 中启用 `keep_vars = true` 对应的 `keep_vars: true`，用于保留 Dashboard 上已有的变量。
- `TURN_SHARED_SECRET` 和 `CF_TURN_API_TOKEN` 属于敏感值，必须以 Secret 方式保存；Cloudflare Secrets 不会在普通 `wrangler deploy` 时被删除。

Worker 会按照 Cloudflare 官方方式，在服务端调用：

```text
POST https://rtc.live.cloudflare.com/v1/turn/keys/<CF_TURN_TOKEN_ID>/credentials/generate-ice-servers
```

凭证优先级为：Cloudflare TURN、自管 TURN、内置 STUN-only。文件仍通过 WebRTC DataChannel 传输，Worker 仅下发短期 ICE 配置，不接收文件数据。ICE policy 保持 `all`，TURN 只作为 P2P 不可用时的候选路线。

当前生产 ICE 配置会过滤 TURN/UDP，仅保留 TURN/TCP 与 TURN/TLS。P2P 的 UDP 直连候选不受影响。该限制用于规避已在多个 TURN 提供者上复现的外部 UDP relay 长时间停滞。

## Diagnostics

浏览器控制台过滤 `conn-metrics`，可查看：

- 首连耗时（`firstConnectMs`）
- 重试次数（`retries`）
- ICE 路径（host/srflx/relay，udp/tcp，LAN/WAN）

## Project Structure

```text
components/      UI 与传输逻辑
constants/       传输与超时参数
src/worker.ts    Worker 入口（API + 资源头部策略）
services/        STUN/TURN 与诊断服务
types/           类型定义
```

## License

MIT
