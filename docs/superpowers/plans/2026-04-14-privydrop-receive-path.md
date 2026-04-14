# PrivyDrop Receive Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reintroduce a PrivyDrop-style desktop-first streaming receive path with explicit writer finalization, reliable resume boundaries, and browser-download fallback only when streaming is unavailable.

**Architecture:** Extract the receiver's streaming write state into a dedicated receive streaming writer service. Keep session coordination, recovery, and persistence orchestration separate, but route desktop streaming, flush, finalize, and resume decisions through the writer service so completion is only acknowledged after writer finalization succeeds.

**Tech Stack:** React 19, TypeScript, browser File System Access API, StreamSaver, Node built-in test runner

---

### Task 1: Lock strategy and orchestrator behavior with tests

**Files:**
- Create: `services/receive/persistenceStrategy.test.ts`
- Create: `services/receive/persistenceOrchestrator.test.ts`
- Modify: `package.json`

- [ ] Add strategy tests for desktop native FS preference, StreamSaver fallback, iOS IndexedDB buffering, and memory fallback.
- [ ] Add orchestrator tests that prove finalize waits for queued flushes and marks files persisted only after save/close succeeds.
- [ ] Add a repo test script for these receive-layer tests.

### Task 2: Extract streaming writer service

**Files:**
- Create: `services/receive/streamingWriter.ts`
- Create: `services/receive/streamingWriter.test.ts`

- [ ] Build a dedicated writer service that owns streaming target state, pending chunk batching, flush queueing, close/abort, and native resume reopen.
- [ ] Track committed bytes and buffered bytes so the recovery path can reason about real writer state instead of ad-hoc refs.
- [ ] Cover writer batching/finalize/abort/resume behavior with focused unit tests.

### Task 3: Rewire Receiver to use the writer service

**Files:**
- Modify: `components/Receiver.tsx`
- Modify: `services/receive/sessionCoordinator.ts`
- Modify: `services/receive/recoveryCoordinator.ts`
- Modify: `services/receive/persistenceStrategy.ts`

- [ ] Remove the current browser-download-first desktop preference and restore native streaming as the primary desktop strategy.
- [ ] Route desktop chunk buffering, flush, finalize, and reopen-for-resume calls through the new writer service.
- [ ] Restore native file picker usage for single-file desktop transfers while preserving browser-download fallback when native streaming is unavailable.

### Task 4: Verify end-to-end invariants

**Files:**
- Modify: `README.md` if behavior notes need updating

- [ ] Run receive-layer tests.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Summarize remaining runtime risks that still need browser/manual verification.
