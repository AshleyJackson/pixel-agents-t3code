import { describe, expect, it, vi } from 'vitest';

import { toPersistedAgent } from '../src/agentPersistence.js';
import type { AgentRuntime } from '../src/agentRuntime.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { setAgentRemovalCallback, startStaleExternalAgentCheck } from '../src/fileWatcher.js';
import {
  normalizeT3ShellSnapshot,
  T3ActivityBridge,
  t3ShellSnapshotUrl,
} from '../src/providers/t3/t3ActivityBridge.js';

function snapshot(threads: unknown[]) {
  return {
    snapshotSequence: 1,
    updatedAt: '2026-11-19T00:00:00.000Z',
    projects: [
      { id: 'project-1', title: 'ignored title', workspaceRoot: 'C:\\work\\pixel-agents' },
    ],
    threads,
  };
}

function thread(overrides: Record<string, unknown> = {}) {
  return {
    id: 'thread-1',
    projectId: 'project-1',
    title: 'private thread title',
    status: 'running',
    activityRunStatus: 'running',
    activeRunId: 'run-1',
    activeProviderThreadId: 'provider-thread-1',
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

describe('T3 activity bridge', () => {
  it('normalizes only thread lifecycle, safe project basename, and wait state', () => {
    const normalized = normalizeT3ShellSnapshot(
      snapshot([
        thread(),
        thread({ id: 'approval', hasPendingApprovals: true }),
        thread({ id: 'input', hasPendingUserInput: true }),
        thread({
          id: 'idle',
          status: 'idle',
          activityRunStatus: null,
          activeRunId: null,
        }),
        thread({
          id: 'completed',
          status: 'completed',
          activityRunStatus: null,
          activeRunId: null,
        }),
        thread({
          id: 'empty-idle',
          status: 'idle',
          activityRunStatus: null,
          activeRunId: null,
          activeProviderThreadId: null,
        }),
        thread({ id: 'archived', archivedAt: '2026-11-18T00:00:00.000Z' }),
        thread({ id: 'deleted', deletedAt: '2026-11-18T00:00:00.000Z' }),
        thread({ id: 'failed', status: 'failed' }),
      ]),
    );

    expect(normalized).toEqual([
      {
        id: 'thread-1',
        projectDir: 'C:\\work\\pixel-agents',
        directoryName: 'pixel-agents',
        status: 'active',
      },
      {
        id: 'approval',
        projectDir: 'C:\\work\\pixel-agents',
        directoryName: 'pixel-agents',
        status: 'permission',
      },
      {
        id: 'input',
        projectDir: 'C:\\work\\pixel-agents',
        directoryName: 'pixel-agents',
        status: 'input',
      },
      {
        id: 'idle',
        projectDir: 'C:\\work\\pixel-agents',
        directoryName: 'pixel-agents',
        status: 'done',
      },
      {
        id: 'completed',
        projectDir: 'C:\\work\\pixel-agents',
        directoryName: 'pixel-agents',
        status: 'done',
      },
    ]);
    expect(JSON.stringify(normalized)).not.toContain('private thread title');
    expect(JSON.stringify(normalized)).not.toContain('ignored title');
  });

  it('rejects malformed snapshots instead of removing tracked agents', () => {
    expect(() => normalizeT3ShellSnapshot({ projects: [], threads: {} })).toThrow(
      'invalid T3 shell snapshot',
    );
    expect(() => normalizeT3ShellSnapshot(snapshot([thread({ session: undefined })]))).toThrow(
      'invalid T3 session',
    );
    expect(() =>
      normalizeT3ShellSnapshot(snapshot([thread({ status: 'unknown-status' })])),
    ).toThrow('invalid T3 thread status');
  });

  it('omits settled threads but keeps threads reopened after settlement', () => {
    const normalized = normalizeT3ShellSnapshot(
      snapshot([
        thread({
          id: 'settled-override',
          settledOverride: 'settled',
          settledAt: '2026-11-18T10:00:00.000Z',
        }),
        thread({
          id: 'settled-by-time',
          settledAt: '2026-11-18T10:00:00.000Z',
        }),
        thread({
          id: 'reopened-after-settle',
          status: 'completed',
          activityRunStatus: null,
          activeRunId: null,
          settledAt: '2026-11-18T10:00:00.000Z',
          unsettledAt: '2026-11-18T10:01:00.000Z',
        }),
        thread({
          id: 'explicitly-active',
          status: 'completed',
          activityRunStatus: null,
          activeRunId: null,
          settledOverride: 'active',
          settledAt: '2026-11-18T10:00:00.000Z',
        }),
      ]),
    );

    expect(normalized.map(({ id }) => id)).toEqual(['reopened-after-settle', 'explicitly-active']);
    expect(normalized.every(({ status }) => status === 'done')).toBe(true);
  });

  it('requires TLS for non-loopback URLs and never embeds auth in the request URL', () => {
    expect(t3ShellSnapshotUrl('http://127.0.0.1:3773/')).toBe(
      'http://127.0.0.1:3773/api/orchestration/shell',
    );
    expect(t3ShellSnapshotUrl('https://t3.example/t3')).toBe(
      'https://t3.example/t3/api/orchestration/shell',
    );
    expect(() => t3ShellSnapshotUrl('http://t3.example')).toThrow(/HTTPS/);
    expect(() => t3ShellSnapshotUrl('https://user:pass@t3.example')).toThrow(
      /embedded credentials/,
    );
    expect(() => t3ShellSnapshotUrl('https://t3.example/?token=secret')).toThrow(
      /embedded credentials/,
    );
  });

  it('keeps source-managed agents out of transcript cleanup and persistence', () => {
    vi.useFakeTimers();
    const store = new AgentStateStore();
    const agent = createAgentState({
      id: 1,
      sessionId: 't3:env:thread',
      isExternal: true,
      transient: true,
      projectDir: '',
      jsonlFile: '',
    });
    const removeAgent = vi.fn((id: number) => store.delete(id));
    store.set(1, agent);
    setAgentRemovalCallback(removeAgent);
    const interval = startStaleExternalAgentCheck(store, new Set(), { current: false });

    try {
      vi.advanceTimersByTime(30_000);
      expect(store.has(1)).toBe(true);
      expect(removeAgent).not.toHaveBeenCalled();
      expect(toPersistedAgent(agent)).toBeNull();
    } finally {
      clearInterval(interval);
      setAgentRemovalCallback(null);
      vi.useRealTimers();
    }
  });

  it('creates a transient character and reports only generic activity using the read token', async () => {
    const store = new AgentStateStore();
    const runtime = {
      unregisterAgent: vi.fn(),
      removeAgent: vi.fn((id: number) => store.delete(id)),
    } as unknown as AgentRuntime;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer read-token');
      expect(headers.get('x-t3-orchestration-protocol')).toBe('2');
      return new Response(
        JSON.stringify(
          snapshot([
            thread(),
            thread({
              id: 'needs-input',
              status: 'completed',
              activityRunStatus: null,
              activeRunId: null,
              hasPendingUserInput: true,
            }),
          ]),
        ),
        { status: 200 },
      );
    });
    const bridge = new T3ActivityBridge({
      baseUrl: 'http://127.0.0.1:3773',
      token: ' read-token ',
      store,
      runtime,
      fetchImpl,
      pollIntervalMs: 60_000,
    });
    const messages: Array<Record<string, unknown>> = [];
    store.on('broadcast', (message) => messages.push(message as Record<string, unknown>));

    bridge.start();
    try {
      await vi.waitFor(() => expect(store.size).toBe(2));
      const [agent, waitingAgent] = [...store.values()];
      expect(agent).toMatchObject({
        isExternal: true,
        hooksOnly: true,
        transient: true,
        providerId: 't3',
        directoryName: 'pixel-agents',
        turnActive: true,
      });
      expect(agent.activeToolStatuses.get('t3-observed-turn')).toBe('Working in T3 Code');
      expect(messages).toContainEqual(
        expect.objectContaining({
          type: 'agentToolStart',
          status: 'Working in T3 Code',
          toolName: 'T3',
        }),
      );
      expect(
        messages.some((message) => JSON.stringify(message).includes('private thread title')),
      ).toBe(false);
      expect(waitingAgent).toMatchObject({ isWaiting: true, awaitingInput: true });
      expect(messages).toContainEqual(
        expect.objectContaining({
          type: 'agentStatus',
          status: 'waiting',
          awaitingInput: true,
        }),
      );
    } finally {
      bridge.stop();
    }
  });

  it('does not recreate a locally dismissed thread until it leaves the snapshot', async () => {
    let currentThreads: unknown[] = [thread()];
    let responseCount = 0;
    const fetchImpl = vi.fn(async () => {
      responseCount++;
      return new Response(JSON.stringify(snapshot(currentThreads)), { status: 200 });
    });
    const store = new AgentStateStore();
    const runtime = {
      unregisterAgent: vi.fn(),
      removeAgent: vi.fn((id: number) => store.delete(id)),
    } as unknown as AgentRuntime;
    const bridge = new T3ActivityBridge({
      baseUrl: 'http://127.0.0.1:3773',
      token: 'read-token',
      store,
      runtime,
      fetchImpl,
      pollIntervalMs: 100,
    });

    bridge.start();
    try {
      await vi.waitFor(() => expect(store.size).toBe(1));
      const dismissedId = [...store.keys()][0];
      store.delete(dismissedId);

      await vi.waitFor(() => expect(responseCount).toBeGreaterThanOrEqual(2));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(store.size).toBe(0);

      currentThreads = [];
      await vi.waitFor(() => expect(responseCount).toBeGreaterThanOrEqual(3));
      await new Promise((resolve) => setTimeout(resolve, 0));
      currentThreads = [thread()];
      await vi.waitFor(() => expect(store.size).toBe(1));
    } finally {
      bridge.stop();
    }
  });
});
