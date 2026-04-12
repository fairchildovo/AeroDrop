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

## TURN Configuration (Recommended)

在运行环境配置以下变量：

- `TURN_URLS`
- `TURN_USERNAME`
- `TURN_CREDENTIAL`

建议 `TURN_URLS` 同时包含：

- `turn:...:3478?transport=udp`
- `turn:...:3478?transport=tcp`
- `turns:...:443?transport=tcp`

示例：

```text
turn:your-turn.example.com:3478?transport=udp,turn:your-turn.example.com:3478?transport=tcp,turns:your-turn.example.com:443?transport=tcp
```

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
