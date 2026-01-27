import * as net from "node:net";
import { resolveFetch, createFetchWithRetry } from "../infra/fetch.js";
import type { TelegramNetworkConfig } from "../config/types.telegram.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveTelegramAutoSelectFamilyDecision } from "./network-config.js";

let appliedAutoSelectFamily: boolean | null = null;
const log = createSubsystemLogger("telegram/network");

const TELEGRAM_FETCH_TIMEOUT_MS = 30_000;
const TELEGRAM_FETCH_MAX_RETRIES = 3;

function applyTelegramNetworkWorkarounds(network?: TelegramNetworkConfig): void {
  const decision = resolveTelegramAutoSelectFamilyDecision({ network });
  if (decision.value === null || decision.value === appliedAutoSelectFamily) return;
  appliedAutoSelectFamily = decision.value;

  if (typeof net.setDefaultAutoSelectFamily === "function") {
    try {
      net.setDefaultAutoSelectFamily(decision.value);
      const label = decision.source ? ` (${decision.source})` : "";
      log.info(`telegram: autoSelectFamily=${decision.value}${label}`);
    } catch {
      // ignore if unsupported by the runtime
    }
  }
}

export function resolveTelegramFetch(
  proxyFetch?: typeof fetch,
  options?: { network?: TelegramNetworkConfig; enableRetry?: boolean },
): typeof fetch | undefined {
  applyTelegramNetworkWorkarounds(options?.network);

  const baseFetch = proxyFetch ? resolveFetch(proxyFetch) : resolveFetch();
  if (!baseFetch) {
    throw new Error("fetch is not available; set channels.telegram.proxy in config");
  }

  if (options?.enableRetry === false) {
    return baseFetch;
  }

  return createFetchWithRetry(baseFetch, {
    attempts: TELEGRAM_FETCH_MAX_RETRIES,
    timeoutMs: TELEGRAM_FETCH_TIMEOUT_MS,
  });
}
