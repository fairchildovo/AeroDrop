# AGENTS.md

## Cursor Cloud specific instructions

**AeroDrop** is a peer-to-peer file transfer and screen sharing web app built with React 19 + TypeScript + Vite + PeerJS (WebRTC).

### Quick reference

- Dev server: `npm run dev` (port 3000, host 0.0.0.0)
- Build: `npm run build`
- Type check: `npx tsc --noEmit` (1 pre-existing `webkitdirectory` type error — safe to ignore)
- No ESLint or test framework is configured in this project.

### Caveats

- The app requires **internet access** for PeerJS signaling (`0.peerjs.com`) and public STUN servers. Without internet, WebRTC connections will fail.
- The Cloudflare Pages Function (`/api/network-check`) only works when deployed to Cloudflare Pages. In local dev, the app detects this and shows a simulated proxy/VPN warning banner — this is expected behavior.
- `GEMINI_API_KEY` env var is referenced in `vite.config.ts` but is optional and not required for core functionality.
- To test the full send/receive P2P flow locally, open two browser tabs/windows pointing to `http://localhost:3000`.
