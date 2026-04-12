# AeroDrop 可直接复用的设计建议

更新时间：2026-04-12  
基于：当前 `AeroDrop` 代码 + `PrivyDrop` 架构分析  
说明：本文件仅保存在本地工作区，不做提交或上传。

## 1. 先说判断

当前 `AeroDrop` 并不是“能力不够”，而是“能力已经长出来了，但组织方式还偏集中”。

从代码上看，`AeroDrop` 已经具备不少很强的实现：

- React 19 + Vite + Cloudflare Worker 的轻量部署形态。
- PeerJS + 动态 ICE/TURN 配置。
- 大文件读取缓冲、DataChannel 背压控制。
- CRC32 校验和断点恢复。
- StreamSaver / 原生写盘 / iOS IndexedDB 缓冲的多策略接收端。
- Happy Eyeballs 式的 P2P / relay 并行连接尝试。
- 屏幕共享模式和 PWA 更新提示。

所以，当前最值得做的，不是“照抄 PrivyDrop”，而是把 PrivyDrop 的**架构拆分思路**迁移过来，让 AeroDrop 更容易继续演进。

一句话建议：

**保留 AeroDrop 现有传输内核，优先重构边界，而不是重写协议。**

---

## 2. 当前 AeroDrop 的真实现状

### 2.1 现有优势

和 PrivyDrop 对比，AeroDrop 其实已经在某些点上走得更前：

1. 连接策略更激进。
当前 `Receiver.tsx` 有明显的 happy-eyeballs 思路，会并行尝试普通 P2P 与 relay 路径，这比很多纯 WebRTC demo 更工程化。

2. 传输链路更关注真实网络表现。
`Sender.tsx` 里已经按 LAN / WAN / relay 调 chunk size 和水位线，还会动态读取 `RTCPeerConnection.getStats()` 调优。

3. 接收端兼容性考虑更细。
你已经做了：
   - 原生文件写入
   - StreamSaver
   - iOS/Safari 兜底
   - IndexedDB 缓冲

4. 协议也不是裸传。
已有 `FILE_START / FILE_COMPLETE / RESUME_REQUEST / TRANSFER_PROGRESS / DEVICE_INFO / HEARTBEAT` 等控制消息。

### 2.2 当前主要瓶颈

当前最大的问题不是功能缺失，而是**代码组织和演进成本**：

1. `components/Sender.tsx` 和 `components/Receiver.tsx` 过大。
它们同时承担了：
   - UI
   - 状态管理
   - Peer 生命周期
   - 传输协议
   - 文件读取/写入
   - 错误恢复
   - 统计与 telemetry

2. 连接层、传输层、状态层没有清晰边界。
这会导致以后新增：
   - 多接收端
   - 房间共享
   - 传输队列
   - 文本/剪贴板同步
   - 后台恢复
时，修改面会非常大。

3. 应用级状态过于分散在组件 `useState/useRef` 中。
这对于当前单页单连接还能承受，但一旦要支持更长生命周期、页面内切换不断传、后台恢复，会越来越吃力。

4. 当前更像“一个非常强的单收单发实现”，还不是“可复用的传输平台层”。

---

## 3. 最值得直接复用的 5 个设计方向

下面这 5 个建议，是我认为对当前 AeroDrop 最直接、最值回票价的改造方向。

### 3.1 建议一：先把 `Sender/Receiver` 拆成“页面协调器 + 传输服务”

这是第一优先级。

建议目标：

- `Sender.tsx` / `Receiver.tsx` 只保留：
  - 页面状态绑定
  - UI 事件响应
  - 通知展示
- 把复杂逻辑迁到 `services/transfer/` 或 `services/p2p/` 下。

建议拆法：

1. `services/p2p/baseConnection.ts`
职责：
   - PeerJS 初始化
   - DataConnection 生命周期
   - 心跳
   - 重连
   - ICE stats 采集

2. `services/transfer/sendOrchestrator.ts`
职责：
   - `FILE_START`
   - chunk 发送
   - 背压控制
   - 断点续传从 offset 继续
   - 完成确认

3. `services/transfer/receiveOrchestrator.ts`
职责：
   - `FILE_START` 处理
   - chunk 接收
   - 校验
   - 写盘策略选择
   - 文件完成与恢复

4. `services/transfer/protocol.ts`
职责：
   - `P2PMessage` 构造
   - 协议版本
   - 消息 decode / guard

5. `services/transfer/progressTracker.ts`
职责：
   - 实时速度
   - 平均速度
   - overall progress
   - per-peer progress

为什么这件事最重要：

- 它不会破坏你已经验证过的协议能力。
- 但会明显降低后续 feature 的实现成本。
- 也是引入多接收端、共享状态、页面内不断传的前置条件。

### 3.2 建议二：引入一个“全局传输状态层”，不要再让组件独占所有状态

建议引入 `Zustand`，不是因为流行，而是因为现在 AeroDrop 的状态已经明显超出单组件舒适区了。

推荐状态分组：

1. 会话状态
- 当前模式：send / receive / screen
- 当前连接状态
- 当前 peer / session id
- 是否正在重连

2. 发送状态
- 待发送文件列表
- 当前发送文件索引
- 总进度
- 各 peer 进度
- 速率、ETA

3. 接收状态
- 元数据
- 已完成文件
- 当前接收文件
- 续传点
- 持久化方式：memory / native / streamSaver / idb

4. UI 状态
- 通知
- 网络风险 banner
- 更新提示

当前收益：

- `App.tsx`、`Sender.tsx`、`Receiver.tsx` 不再互相“传状态碎片”。
- 以后如果你想做“页面内切换发送/接收时不断开”，状态就有了承接点。
- 也更容易做调试面板和 telemetry 看板。

### 3.3 建议三：把当前协议升级成“元数据广播 + 接收端请求”的标准流程

你现在已经有 `RESUME_REQUEST`，这说明 AeroDrop 已经具备“接收端驱动续传”的雏形。

建议进一步统一成下面这套主链路：

1. 发送端先发一次 `METADATA`。
2. 接收端用户确认后，再按文件发 `REQUEST_FILE(fileIndex, offset)`。
3. 发送端仅对被请求文件开始发送。
4. 文件完成后接收端回 `FILE_RECEIVE_COMPLETE`。
5. 多文件模式下按需请求下一个文件。

这样做的好处：

- 逻辑比“发送端一股脑开传”更稳。
- 续传语义会更干净。
- 为未来多接收端做准备。
- 文件夹、文本、屏幕共享流都更容易复用同一套会话模型。

这点是 PrivyDrop 非常值得借鉴的地方。

### 3.4 建议四：把“连接策略”从 `Sender/Receiver` 内联逻辑提炼成一个独立策略模块

当前 AeroDrop 的连接策略其实挺先进，但太散在组件里了。

建议提炼出：

- `services/p2p/connectionPolicy.ts`
- `services/p2p/connectionStats.ts`

把这些逻辑统一收进去：

- ICE config 获取
- `all` / `relay` policy 切换
- happy-eyeballs 并行尝试
- candidate pair 统计
- 连接类型判定：LAN / P2P / relay
- 根据 RTT / loss / bitrate 产出 flow profile

这一步的收益非常实际：

- `Sender.tsx` 和 `Receiver.tsx` 会立刻瘦很多。
- 网络调优逻辑能单独测试。
- 未来如果从 PeerJS 切到更底层的原生 WebRTC，策略层还可以复用。

### 3.5 建议五：把“接收端持久化策略”做成明确的策略表，而不是散落在条件分支里

你现在的接收端已经有四种落盘路径：

- 内存 Blob
- 原生文件写入
- StreamSaver
- IndexedDB 缓冲

建议做一个清晰的策略决策器：

`services/receive/persistenceStrategy.ts`

输入：

- 浏览器能力
- 平台类型
- 文件大小
- 是否支持原生写盘
- 是否 Safari / iOS

输出：

- `memory`
- `native-fs`
- `stream-saver`
- `indexeddb-buffer`

然后把真正实现拆到：

- `nativeWriter.ts`
- `streamSaverWriter.ts`
- `indexedDbBuffer.ts`
- `memoryAssembler.ts`

这是 AeroDrop 当前最有“资产价值”的一块，值得单独沉淀，因为这部分已经明显不是 demo 级代码了。

---

## 4. 按优先级给出可落地路线

下面是我更推荐的实施顺序，不需要大爆炸重构。

### P0：先做边界重构，不改协议

目标：降低复杂度，不影响当前功能。

建议动作：

1. 把 `Sender.tsx` 中的连接管理抽成 `services/p2p/senderConnection.ts`
2. 把 `Receiver.tsx` 中的连接管理抽成 `services/p2p/receiverConnection.ts`
3. 把发送 chunk 的主循环抽成 `sendOrchestrator`
4. 把接收 chunk + 写盘抽成 `receiveOrchestrator`
5. 引入 `transferStore`

完成标志：

- `Sender.tsx` 和 `Receiver.tsx` 每个都降到 400-600 行以内。
- UI 组件不再直接碰太多低层 `peerRef/dataChannel/writeQueue`。

### P1：统一协议为“接收端请求式”

目标：让续传、多文件、多接收端更自然。

建议动作：

1. 明确请求消息结构，例如：
   - `REQUEST_FILE`
   - `REQUEST_RANGE`
   - `FILE_RECEIVE_COMPLETE`
2. 把当前 `RESUME_REQUEST` 语义升级成通用请求语义。
3. 发送端只响应请求，不主动推完整文件。

完成标志：

- 每个文件都能独立重试、独立续传。
- 发送端逻辑可以按 fileIndex/fileId 清晰追踪。

### P2：为多接收端做结构预埋

目标：先把架构准备好，不一定马上把功能全部放开。

建议动作：

1. 把当前单连接引用改成面向 `peerId -> connection` 的结构。
2. 进度状态改成 per-peer 结构。
3. 让发送端的 orchestrator 支持“为指定 peer 发送”。

完成标志：

- 即使 UI 还不开放多接收端，底层也不再假设只有一个 receiver。

### P3：考虑是否逐步弱化 PeerJS 依赖

这是中期建议，不是立刻要做。

为什么提这个：

- 你现在很多高级能力其实已经绕过 PeerJS 做了不少底层处理。
- 如果未来要做更复杂的连接控制，多 peer 管理，甚至自定义信令，PeerJS 可能会逐渐成为上限。

建议方式不是“一次性迁移”：

1. 先定义 `ConnectionAdapter` 接口。
2. 当前实现仍然是 `PeerJsAdapter`。
3. 未来再补 `NativeWebRtcAdapter`。

这样就不会被绑定死。

---

## 5. 对当前代码的具体映射建议

### 5.1 `App.tsx`

当前做得不错，适合继续做“外壳层”。

建议保留职责：

- 路由模式切换
- 风险 banner
- PWA 更新提示
- lazy load

不建议再往里面塞更多传输逻辑。

### 5.2 `components/Sender.tsx`

建议拆成：

- `components/sender/SenderPage.tsx`
- `hooks/useSenderSession.ts`
- `services/p2p/senderConnection.ts`
- `services/transfer/sendOrchestrator.ts`

重点下沉的内容：

- `peerRef / activeConnections / heartbeat / telemetry`
- `updateConnectionStats`
- `adaptive flow`
- 实际文件发送循环

### 5.3 `components/Receiver.tsx`

建议拆成：

- `components/receiver/ReceiverPage.tsx`
- `hooks/useReceiverSession.ts`
- `services/p2p/receiverConnection.ts`
- `services/transfer/receiveOrchestrator.ts`
- `services/receive/persistence/`

重点下沉的内容：

- happy-eyeballs 连接逻辑
- IndexedDB/StreamSaver/native writer
- 文件恢复与修复
- chunk 缓冲与写入

### 5.4 `services/stunService.ts`

这块已经适合作为独立模块保留。  
建议补的不是重写，而是：

- 与 connection policy 组合。
- 暴露更明确的能力对象，例如：
  - `hasTurn`
  - `iceTransportPolicy`
  - `iceServers`
  - `fetchLatencyMs`

### 5.5 `src/worker.ts`

Worker 这一层现在职责很清晰，建议继续保持“极薄边缘 API”：

- ICE/TURN 配置下发
- 网络环境检查
- 心跳

如果未来你要引入更稳定的房间/会话协助，也建议仍保持它只是“协调层”，不要让文件流经过 Worker。

---

## 6. 我认为最适合 AeroDrop 直接借鉴 PrivyDrop 的点

只挑最适合你当前项目的，不泛化。

### 可直接借鉴 1：单例长生命周期连接服务

如果你后面想做：

- 页面内切换模式时不断传
- 某些状态跨组件保留
- 更稳定的重连

那可以借鉴 PrivyDrop 的做法，增加一个单例 `sessionService` 或 `transferService`，承接：

- 当前 peer 连接
- 当前发送/接收 orchestrator
- 共享状态桥接

### 可直接借鉴 2：真正的 per-peer 进度模型

PrivyDrop 的 `fileId -> peerId -> progress` 这类结构很适合 AeroDrop 的下一阶段。  
你现在已经有 `individualStats` 的概念了，只是底层还没完全被抽象成统一模型。

### 可直接借鉴 3：服务层优先于 Hook/组件层

PrivyDrop 真正值钱的不是“用了 Zustand”，而是它把复杂的东西放到了服务层。  
这非常适合 AeroDrop 当前阶段，因为你现有底层逻辑已经足够复杂，继续堆在组件里只会更难维护。

### 可直接借鉴 4：接收端主导的传输控制

你已经有恢复能力，再往前走一步，把“请求哪个文件、从哪恢复、何时确认完成”彻底变成接收端主导，会让协议更稳、更好扩展。

---

## 7. 不建议现在做的事

为了避免重构过猛，我反而建议先不要做下面这些：

1. 不建议马上从 PeerJS 全量切到原生 WebRTC。
成本太高，风险也大。先做 adapter 抽象更稳。

2. 不建议现在就加服务端中转文件。
这会改变产品边界，而且会立刻抬高带宽成本和复杂度。

3. 不建议先做 UI 大改。
现在最值得投入的是架构边界，不是视觉层。

4. 不建议一次性把 Sender/Receiver 全部拆完。
应该按“连接层 -> 传输层 -> 持久化层 -> 状态层”分批抽离。

---

## 8. 我给你的推荐执行顺序

如果要我来排一个最实用的路线，我会建议这样做：

1. 第一步：引入 `transferStore`，把关键状态迁出来。
2. 第二步：抽 `sendOrchestrator` 和 `receiveOrchestrator`。
3. 第三步：抽 `connectionPolicy` 和 `connectionStats`。
4. 第四步：把接收端写盘策略独立成 `persistence` 模块。
5. 第五步：把协议统一到“metadata + request + complete”模型。
6. 第六步：为多接收端改底层数据结构。

这样每一步都能单独验收，不会把现有可用能力打碎。

---

## 9. 最后一句总结

对当前 AeroDrop 来说，最值得直接复用的不是 PrivyDrop 的技术栈，而是它的**架构分层方式**。

你现在已经有一个很强的传输内核了，下一步最应该做的是：

**把连接、协议、传输、持久化、UI 状态拆开，让 AeroDrop 从“功能强的单页实现”进化成“可持续演进的 P2P 传输架构”。**
