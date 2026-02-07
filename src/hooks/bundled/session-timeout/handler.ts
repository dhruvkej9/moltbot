/**
 * Session Timeout Hook Handler
 *
 * Prevents stuck runs from blocking new messages by:
 * 1. Monitoring active run duration
 * 2. Detecting orphaned runs (completed in file but active in memory)
 * 3. Auto-clearing stuck runs after timeout
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { HookHandler } from "../../hooks.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveHookConfig } from "../../config.js";

const log = createSubsystemLogger("hooks/session-timeout");

// Track run start times and states
const runTracker = new Map<
  string,
  {
    startTime: number;
    lastActivity: number;
    runId: string;
    sessionId: string;
  }
>();

// Default configuration
const DEFAULT_MAX_RUN_MINUTES = 15;
const DEFAULT_CHECK_INTERVAL_MS = 30000; // 30 seconds

/**
 * Check if a session file indicates run completion (has compaction or done entry)
 */
async function checkSessionCompletion(sessionFilePath: string): Promise<boolean> {
  try {
    const content = await fs.readFile(sessionFilePath, "utf-8");
    const lines = content.trim().split("\n");

    // Check last few entries for completion indicators
    const recentLines = lines.slice(-10);
    for (const line of recentLines) {
      try {
        const entry = JSON.parse(line);
        // Compaction or completion indicators
        if (
          entry.type === "compaction" ||
          (entry.type === "message" &&
            entry.message?.role === "assistant" &&
            entry.message?.stopReason) ||
          (entry.type === "custom" && entry.customType === "model-snapshot")
        ) {
          return true;
        }
      } catch {
        // Skip invalid lines
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Clean up stuck lock files
 */
async function cleanupStuckLocks(sessionsDir: string): Promise<number> {
  let cleaned = 0;
  try {
    const files = await fs.readdir(sessionsDir);
    const now = Date.now();

    for (const file of files) {
      if (file.endsWith(".lock")) {
        const lockPath = path.join(sessionsDir, file);
        try {
          const stats = await fs.stat(lockPath);
          const ageMinutes = (now - stats.mtime.getTime()) / (1000 * 60);

          if (ageMinutes > 10) {
            await fs.unlink(lockPath);
            cleaned++;
            log.info(`Removed stuck lock file: ${file} (age: ${Math.round(ageMinutes)}min)`);
          }
        } catch {
          // File might be gone already
        }
      }
    }
  } catch (err) {
    log.error("Failed to cleanup locks", { error: String(err) });
  }
  return cleaned;
}

/**
 * Monitor and cleanup stuck runs
 */
async function monitorStuckRuns(): Promise<void> {
  const now = Date.now();
  const stuckRuns: string[] = [];

  for (const [sessionKey, data] of runTracker.entries()) {
    const durationMinutes = (now - data.startTime) / (1000 * 60);

    if (durationMinutes > DEFAULT_MAX_RUN_MINUTES) {
      stuckRuns.push(sessionKey);
      log.warn(`Detected stuck run`, {
        sessionKey,
        runId: data.runId,
        durationMinutes: Math.round(durationMinutes),
      });
    }
  }

  // Remove stuck runs from tracking
  for (const sessionKey of stuckRuns) {
    runTracker.delete(sessionKey);
    log.info(`Cleared stuck run from tracker: ${sessionKey}`);
  }
}

/**
 * Main hook handler
 */
const sessionTimeoutHandler: HookHandler = async (event) => {
  // Only handle session lifecycle events
  if (event.type !== "session") {
    return;
  }

  const { action, sessionKey, context } = event;
  const cfg = context?.cfg as Record<string, unknown> | undefined;

  // Get hook configuration
  const hookConfig = resolveHookConfig(cfg, "session-timeout");
  const enabled = hookConfig?.enabled !== false; // Default: enabled

  if (!enabled) {
    return;
  }

  const maxRunMinutes =
    typeof hookConfig?.maxRunDurationMinutes === "number"
      ? hookConfig.maxRunDurationMinutes
      : DEFAULT_MAX_RUN_MINUTES;

  try {
    switch (action) {
      case "run:start": {
        const runId = context?.runId as string;
        const sessionId = context?.sessionId as string;

        if (runId && sessionId) {
          runTracker.set(sessionKey, {
            startTime: Date.now(),
            lastActivity: Date.now(),
            runId,
            sessionId,
          });
          log.debug(`Tracked new run`, { sessionKey, runId, sessionId });
        }
        break;
      }

      case "run:end":
      case "run:complete":
      case "run:abort": {
        // Run ended normally - remove from tracker
        if (runTracker.has(sessionKey)) {
          const data = runTracker.get(sessionKey)!;
          const duration = (Date.now() - data.startTime) / 1000;
          runTracker.delete(sessionKey);
          log.debug(`Run completed and removed from tracker`, {
            sessionKey,
            durationSeconds: Math.round(duration),
          });
        }
        break;
      }

      case "health:check": {
        // Periodic health check
        await monitorStuckRuns();

        // Also cleanup stuck locks
        const sessionsDir = path.join(
          process.env.HOME || "/home/ubuntu",
          ".openclaw",
          "agents",
          "whatsapp",
          "sessions",
        );
        const cleaned = await cleanupStuckLocks(sessionsDir);
        if (cleaned > 0) {
          log.info(`Health check: cleaned ${cleaned} stuck locks`);
        }
        break;
      }
    }
  } catch (err) {
    log.error(`Session timeout handler error`, {
      action,
      sessionKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

// Start periodic health checks
setInterval(async () => {
  try {
    await sessionTimeoutHandler({
      type: "session",
      action: "health:check",
      sessionKey: "health-monitor",
      context: {},
      timestamp: new Date(),
      messages: [],
    });
  } catch (err) {
    log.error("Health check error", { error: String(err) });
  }
}, DEFAULT_CHECK_INTERVAL_MS);

export default sessionTimeoutHandler;
