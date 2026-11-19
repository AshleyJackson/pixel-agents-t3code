import { createHash, randomUUID } from 'node:crypto';

import { isRecord } from '../../../../core/src/isRecord.js';
import type { AgentRuntime } from '../../agentRuntime.js';
import { createAgentState } from '../../agentState.js';
import type { AgentStateStore } from '../../agentStateStore.js';
import { assignPaletteIfNeeded } from '../../paletteAssigner.js';

const POLL_INTERVAL_MS = 3_000;
const REQUEST_TIMEOUT_MS = 5_000;
const ORCHESTRATION_PROTOCOL_HEADER = 'x-t3-orchestration-protocol';
const ORCHESTRATION_PROTOCOL_VERSION = '2';
const OBSERVED_TOOL_ID = 't3-observed-turn';
const OBSERVED_TOOL_NAME = 'T3';
const OBSERVED_TOOL_STATUS = 'Working in T3 Code';

type ObservedStatus = 'active' | 'permission' | 'input' | 'done';

interface ObservedThread {
  id: string;
  projectDir: string;
  directoryName: string;
  status: ObservedStatus;
}

interface TrackedAgent {
  id: number;
  sessionId: string;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function timestampField(value: unknown, field: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  const timestamp =
    typeof value === 'number' && Number.isFinite(value)
      ? value
      : typeof value === 'string'
        ? Date.parse(value)
        : Number.NaN;
  if (!Number.isFinite(timestamp)) throw new Error(`invalid T3 ${field}`);
  return timestamp;
}

function isSettledThread(value: Record<string, unknown>): boolean {
  if (value.settledOverride === 'settled') return true;
  if (value.settledOverride === 'active') return false;

  const settledAt = timestampField(value.settledAt, 'settledAt');
  const unsettledAt = timestampField(value.unsettledAt, 'unsettledAt');
  return settledAt !== undefined && (unsettledAt === undefined || settledAt >= unsettledAt);
}

function basename(value: string): string {
  return (
    value
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1) || 'T3 Code'
  );
}

/** Validate a T3 shell response and retain only fields needed for office state. */
export function normalizeT3ShellSnapshot(raw: unknown): ObservedThread[] {
  if (!isRecord(raw) || !Array.isArray(raw.projects) || !Array.isArray(raw.threads)) {
    throw new Error('invalid T3 shell snapshot');
  }

  const projects = new Map<string, { directory: string; name: string }>();
  for (const value of raw.projects) {
    if (!isRecord(value)) throw new Error('invalid T3 project entry');
    const id = stringField(value.id);
    const root = stringField(value.workspaceRoot);
    if (!id || !root) throw new Error('invalid T3 project identity');
    projects.set(id, { directory: root, name: basename(root) });
  }

  const observed: ObservedThread[] = [];
  for (const value of raw.threads) {
    if (!isRecord(value)) throw new Error('invalid T3 thread entry');
    const id = stringField(value.id);
    if (!id || id.length > 256) throw new Error('invalid T3 thread identity');
    if (
      (value.archivedAt !== null && value.archivedAt !== undefined) ||
      (value.deletedAt !== null && value.deletedAt !== undefined) ||
      isSettledThread(value)
    ) {
      continue;
    }

    let isActive: boolean;
    if (Object.prototype.hasOwnProperty.call(value, 'session')) {
      // Older shell snapshots wrapped the provider state in `session`.
      if (value.session === null) continue;
      if (!isRecord(value.session)) throw new Error('invalid T3 session');

      const sessionStatus = value.session.status;
      if (
        sessionStatus !== 'idle' &&
        sessionStatus !== 'starting' &&
        sessionStatus !== 'running' &&
        sessionStatus !== 'ready' &&
        sessionStatus !== 'interrupted' &&
        sessionStatus !== 'stopped' &&
        sessionStatus !== 'error'
      ) {
        throw new Error('invalid T3 session status');
      }
      if (sessionStatus === 'stopped' || sessionStatus === 'error') continue;

      const latestTurn = isRecord(value.latestTurn) ? value.latestTurn : undefined;
      isActive =
        sessionStatus === 'starting' ||
        sessionStatus === 'running' ||
        latestTurn?.state === 'running';
    } else {
      // Current T3 shell snapshots expose the provider thread and run state
      // directly on the thread instead of returning a nested session object.
      const threadStatus = value.status;
      if (
        threadStatus !== 'idle' &&
        threadStatus !== 'running' &&
        threadStatus !== 'completed' &&
        threadStatus !== 'failed' &&
        threadStatus !== 'interrupted'
      ) {
        throw new Error('invalid T3 thread status');
      }
      if (threadStatus === 'failed') continue;

      const hasProviderThread = stringField(value.activeProviderThreadId) !== undefined;
      const hasActiveRun = stringField(value.activeRunId) !== undefined;
      if (!hasProviderThread && !hasActiveRun && threadStatus !== 'running') continue;
      isActive =
        threadStatus === 'running' || value.activityRunStatus === 'running' || hasActiveRun;
    }

    const project = projects.get(stringField(value.projectId) ?? '');
    const projectDir = project?.directory ?? '';
    const directoryName = project?.name ?? 'T3 Code';
    const status: ObservedStatus =
      value.hasPendingApprovals === true
        ? 'permission'
        : value.hasPendingUserInput === true
          ? 'input'
          : isActive
            ? 'active'
            : 'done';

    observed.push({ id, projectDir, directoryName, status });
  }
  return observed;
}

export function t3ShellSnapshotUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('T3 URL must be an absolute HTTP(S) URL.');
  }
  const loopback =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1';
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('T3 URL must use HTTPS, or HTTP on loopback, without embedded credentials.');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/orchestration/shell`;
  return url.toString();
}

/**
 * Read-only observer for one T3 Code environment. The shell projection carries
 * lifecycle and pending-input state, but no tool names or message content, so
 * this bridge deliberately emits only a generic active-turn label.
 */
export class T3ActivityBridge {
  private readonly endpoint: string;
  readonly sourceId: string;
  readonly observerId: string;
  private readonly token: string;
  private readonly tracked = new Map<string, TrackedAgent>();
  private readonly dismissed = new Set<string>();
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private connectionWarningShown = false;

  constructor(
    private readonly options: {
      baseUrl: string;
      token: string;
      store: AgentStateStore;
      runtime: AgentRuntime;
      fetchImpl?: typeof fetch;
      pollIntervalMs?: number;
    },
  ) {
    if (!options.token.trim()) throw new Error('T3 token is required.');
    this.endpoint = t3ShellSnapshotUrl(options.baseUrl);
    this.token = options.token.trim();
    const endpointUrl = new URL(this.endpoint);
    this.sourceId = createHash('sha256')
      .update(
        `${endpointUrl.origin}${endpointUrl.pathname.replace(/\/api\/orchestration\/shell$/, '')}`,
      )
      .digest('hex')
      .slice(0, 12);
    this.observerId = randomUUID();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const agent of this.tracked.values()) {
      this.options.runtime.unregisterAgent(agent.sessionId);
      this.options.runtime.removeAgent(agent.id);
    }
    this.tracked.clear();
    this.dismissed.clear();
  }

  private async poll(): Promise<void> {
    if (!this.running) return;
    try {
      const response = await (this.options.fetchImpl ?? fetch)(this.endpoint, {
        headers: {
          authorization: `Bearer ${this.token}`,
          [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION,
        },
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const threads = normalizeT3ShellSnapshot(await response.json());
      this.reconcile(threads);
      if (this.connectionWarningShown) {
        console.log('[Pixel Agents] T3 Code observation reconnected');
        this.connectionWarningShown = false;
      }
    } catch (error) {
      if (!this.connectionWarningShown) {
        const detail =
          error instanceof Error && /^HTTP \d+$/.test(error.message) ? ` (${error.message})` : '';
        console.warn(`[Pixel Agents] T3 Code observation unavailable${detail}; retrying.`);
        this.connectionWarningShown = true;
      }
    } finally {
      if (this.running) {
        this.timer = setTimeout(
          () => void this.poll(),
          this.options.pollIntervalMs ?? POLL_INTERVAL_MS,
        );
      }
    }
  }

  private reconcile(threads: ObservedThread[]): void {
    const observedIds = new Set(threads.map((thread) => thread.id));
    for (const threadId of this.dismissed) {
      if (!observedIds.has(threadId)) this.dismissed.delete(threadId);
    }

    const seen = new Set<string>();
    for (const thread of threads) {
      seen.add(thread.id);
      if (this.dismissed.has(thread.id)) continue;

      const tracked = this.tracked.get(thread.id);
      const agent = tracked ? this.options.store.get(tracked.id) : undefined;
      if (agent) {
        agent.projectDir = thread.projectDir;
        agent.directoryName = thread.directoryName;
        applyObservedStatus(this.options.store, agent.id, thread.status);
        continue;
      }
      if (tracked) {
        // The runtime removed this observed agent at the user's request. Keep
        // the thread hidden until it leaves the source snapshot.
        this.tracked.delete(thread.id);
        this.dismissed.add(thread.id);
        continue;
      }

      const id = this.options.store.nextAgentId.current++;
      const sessionId = `t3:${this.sourceId}:${thread.id}`;
      const created = createAgentState({
        id,
        sessionId,
        isExternal: true,
        hooksOnly: true,
        transient: true,
        providerId: 't3',
        projectDir: thread.projectDir,
        directoryName: thread.directoryName,
        jsonlFile: '',
      });
      assignPaletteIfNeeded(created, this.options.store);
      this.options.store.set(id, created);
      this.tracked.set(thread.id, { id, sessionId });
      applyObservedStatus(this.options.store, id, thread.status, true);
    }

    for (const [threadId, tracked] of this.tracked) {
      if (seen.has(threadId)) continue;
      this.options.runtime.unregisterAgent(tracked.sessionId);
      this.options.runtime.removeAgent(tracked.id);
      this.tracked.delete(threadId);
    }
  }
}

function applyObservedStatus(
  store: AgentStateStore,
  id: number,
  status: ObservedStatus,
  isNew = false,
): void {
  const agent = store.get(id);
  if (!agent) return;
  const previousStatus: ObservedStatus | undefined = agent.permissionSent
    ? 'permission'
    : agent.isWaiting
      ? agent.awaitingInput
        ? 'input'
        : 'done'
      : agent.turnActive
        ? 'active'
        : undefined;
  const hasTool = agent.activeToolIds.has(OBSERVED_TOOL_ID);
  const wantsTool = status === 'active' || status === 'permission';

  if (wantsTool) {
    agent.activeToolIds.add(OBSERVED_TOOL_ID);
    agent.activeToolStatuses.set(OBSERVED_TOOL_ID, OBSERVED_TOOL_STATUS);
    agent.activeToolNames.set(OBSERVED_TOOL_ID, OBSERVED_TOOL_NAME);
    agent.turnActive = true;
    agent.isWaiting = false;
    agent.awaitingInput = false;
    agent.permissionSent = status === 'permission';

    if (!hasTool) {
      store.broadcast({
        type: 'agentToolStart',
        id,
        toolId: OBSERVED_TOOL_ID,
        status: OBSERVED_TOOL_STATUS,
        toolName: OBSERVED_TOOL_NAME,
        permissionActive: status === 'permission' || undefined,
      });
    }
    if (status === 'permission' && previousStatus !== 'permission') {
      store.broadcast({ type: 'agentToolPermission', id });
    } else if (status === 'active' && previousStatus === 'permission') {
      store.broadcast({ type: 'agentToolPermissionClear', id });
    }
    if (isNew || (previousStatus !== 'active' && previousStatus !== 'permission')) {
      store.broadcast({ type: 'agentStatus', id, status: 'active' });
    }
    return;
  }

  agent.activeToolIds.clear();
  agent.activeToolStatuses.clear();
  agent.activeToolNames.clear();
  agent.turnActive = false;
  agent.isWaiting = true;
  agent.awaitingInput = status === 'input';
  agent.permissionSent = false;

  if (hasTool) store.broadcast({ type: 'agentToolsClear', id });
  if (previousStatus === 'permission') {
    store.broadcast({ type: 'agentToolPermissionClear', id });
  }
  if (isNew || previousStatus !== status) {
    store.broadcast({
      type: 'agentStatus',
      id,
      status: 'waiting',
      awaitingInput: status === 'input',
    });
  }
}
