import {
  diagnosticLogger as diag,
  logMessageQueued,
  logSessionStateChange,
} from "../../logging/diagnostic.js";

type EmbeddedPiQueueHandle = {
  queueMessage: (text: string) => Promise<void>;
  isStreaming: () => boolean;
  isCompacting: () => boolean;
  abort: () => void;
};

type RunMetadata = {
  handle: EmbeddedPiQueueHandle;
  startTime: number;
  sessionId: string;
};

const ACTIVE_EMBEDDED_RUNS = new Map<string, RunMetadata>();
type EmbeddedRunWaiter = {
  resolve: (ended: boolean) => void;
  timer: NodeJS.Timeout;
};
const EMBEDDED_RUN_WAITERS = new Map<string, Set<EmbeddedRunWaiter>>();

// Maximum run duration: 15 minutes
const MAX_RUN_DURATION_MS = 15 * 60 * 1000;
// Check for orphaned runs every 30 seconds
const ORPHAN_CHECK_INTERVAL_MS = 30 * 1000;

/**
 * Force cleanup orphaned/stuck runs that have exceeded max duration
 */
function cleanupOrphanedRuns(): void {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [sessionId, metadata] of ACTIVE_EMBEDDED_RUNS.entries()) {
    const duration = now - metadata.startTime;

    if (duration > MAX_RUN_DURATION_MS) {
      // Force cleanup this orphaned run
      ACTIVE_EMBEDDED_RUNS.delete(sessionId);
      logSessionStateChange({
        sessionId,
        state: "idle",
        reason: "orphan_cleanup_timeout",
      });

      // Abort the handle if possible
      try {
        metadata.handle.abort();
      } catch {
        // Ignore abort errors
      }

      // Notify any waiters
      notifyEmbeddedRunEnded(sessionId);

      diag.warn(`orphan run force-cleared: sessionId=${sessionId} durationMs=${duration}`);
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    diag.info(
      `orphan cleanup complete: cleared=${cleanedCount} remaining=${ACTIVE_EMBEDDED_RUNS.size}`,
    );
  }
}

// Start periodic orphan cleanup
setInterval(cleanupOrphanedRuns, ORPHAN_CHECK_INTERVAL_MS);

export function queueEmbeddedPiMessage(sessionId: string, text: string): boolean {
  const metadata = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!metadata) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=no_active_run`);
    return false;
  }
  if (!metadata.handle.isStreaming()) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=not_streaming`);
    return false;
  }
  if (metadata.handle.isCompacting()) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=compacting`);
    return false;
  }
  logMessageQueued({ sessionId, source: "pi-embedded-runner" });
  void metadata.handle.queueMessage(text);
  return true;
}

export function abortEmbeddedPiRun(sessionId: string): boolean {
  const metadata = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!metadata) {
    diag.debug(`abort failed: sessionId=${sessionId} reason=no_active_run`);
    return false;
  }
  diag.debug(`aborting run: sessionId=${sessionId}`);
  metadata.handle.abort();
  return true;
}

export function isEmbeddedPiRunActive(sessionId: string): boolean {
  const active = ACTIVE_EMBEDDED_RUNS.has(sessionId);
  if (active) {
    diag.debug(`run active check: sessionId=${sessionId} active=true`);
  }
  return active;
}

export function isEmbeddedPiRunStreaming(sessionId: string): boolean {
  const metadata = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!metadata) {
    return false;
  }
  return metadata.handle.isStreaming();
}

export function waitForEmbeddedPiRunEnd(sessionId: string, timeoutMs = 15_000): Promise<boolean> {
  if (!sessionId || !ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
    return Promise.resolve(true);
  }
  diag.debug(`waiting for run end: sessionId=${sessionId} timeoutMs=${timeoutMs}`);
  return new Promise((resolve) => {
    const waiters = EMBEDDED_RUN_WAITERS.get(sessionId) ?? new Set();
    const waiter: EmbeddedRunWaiter = {
      resolve,
      timer: setTimeout(
        () => {
          waiters.delete(waiter);
          if (waiters.size === 0) {
            EMBEDDED_RUN_WAITERS.delete(sessionId);
          }
          diag.warn(`wait timeout: sessionId=${sessionId} timeoutMs=${timeoutMs}`);
          resolve(false);
        },
        Math.max(100, timeoutMs),
      ),
    };
    waiters.add(waiter);
    EMBEDDED_RUN_WAITERS.set(sessionId, waiters);
    if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
      waiters.delete(waiter);
      if (waiters.size === 0) {
        EMBEDDED_RUN_WAITERS.delete(sessionId);
      }
      clearTimeout(waiter.timer);
      resolve(true);
    }
  });
}

function notifyEmbeddedRunEnded(sessionId: string) {
  const waiters = EMBEDDED_RUN_WAITERS.get(sessionId);
  if (!waiters || waiters.size === 0) {
    return;
  }
  EMBEDDED_RUN_WAITERS.delete(sessionId);
  diag.debug(`notifying waiters: sessionId=${sessionId} waiterCount=${waiters.size}`);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(true);
  }
}

export function setActiveEmbeddedRun(sessionId: string, handle: EmbeddedPiQueueHandle) {
  const wasActive = ACTIVE_EMBEDDED_RUNS.has(sessionId);
  const metadata: RunMetadata = {
    handle,
    startTime: Date.now(),
    sessionId,
  };
  ACTIVE_EMBEDDED_RUNS.set(sessionId, metadata);
  logSessionStateChange({
    sessionId,
    state: "processing",
    reason: wasActive ? "run_replaced" : "run_started",
  });
  if (!sessionId.startsWith("probe-")) {
    diag.debug(`run registered: sessionId=${sessionId} totalActive=${ACTIVE_EMBEDDED_RUNS.size}`);
  }
}

export function clearActiveEmbeddedRun(sessionId: string, handle: EmbeddedPiQueueHandle) {
  const metadata = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (metadata && metadata.handle === handle) {
    ACTIVE_EMBEDDED_RUNS.delete(sessionId);
    logSessionStateChange({ sessionId, state: "idle", reason: "run_completed" });
    if (!sessionId.startsWith("probe-")) {
      diag.debug(`run cleared: sessionId=${sessionId} totalActive=${ACTIVE_EMBEDDED_RUNS.size}`);
    }
    notifyEmbeddedRunEnded(sessionId);
  } else {
    diag.debug(`run clear skipped: sessionId=${sessionId} reason=handle_mismatch`);
  }
}

export type { EmbeddedPiQueueHandle };
