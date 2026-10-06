import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface Window { used: number | null; minutes: number | null; reset: number | null }
export interface Bucket { name: string; windows: Window[] }
export interface Snapshot {
  buckets: Bucket[]; weekly: Window | null; plan: string | null;
  resetCount: number | null; expiries: (number | null)[]; fetchedAt: number;
}
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const number = (v: unknown, max = Number.MAX_SAFE_INTEGER): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : null;
const timestamp = (v: unknown): number | null => number(v, 8.64e12);
// Server labels are untrusted terminal text, not ANSI or instructions.
const label = (v: unknown): string | null => typeof v === "string"
  ? v.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 80) : null;

export function normalize(raw: unknown, plan: unknown, now = Date.now()): Snapshot {
  const data = record(raw);
  if (!("rateLimits" in data) && !("rateLimitsByLimitId" in data)) {
    throw new Error("Unsupported Codex quota response; update Codex CLI.");
  }
  const map = record(data.rateLimitsByLimitId);
  const entries = Object.entries(map).filter(([, v]) => v !== null && typeof v === "object");
  const hasCodex = entries.some(([id, v]) => id === "codex" || record(v).limitId === "codex");
  const fallback = record(data.rateLimits);
  const fallbackId = label(fallback.limitId) || "codex";
  if (data.rateLimits && (!entries.length || (!hasCodex && fallbackId === "codex"))) {
    entries.push([fallbackId, data.rateLimits]);
  }
  entries.sort(([a], [b]) => a === "codex" ? -1 : b === "codex" ? 1 : a.localeCompare(b));
  const buckets = entries.map(([id, value]) => {
    const b = record(value);
    return {
      name: label(b.limitName) || label(id) || "Unknown bucket",
      windows: [b.primary, b.secondary].filter(v => v !== null && v !== undefined).map(v => {
        const w = record(v);
        return { used: number(w.usedPercent, 100), minutes: number(w.windowDurationMins), reset: timestamp(w.resetsAt) };
      }),
    };
  });
  // Never silently substitute an unrelated model bucket for the Codex quota.
  const selected = entries.findIndex(([id, v]) => id === "codex" || record(v).limitId === "codex");
  const weekly = selected < 0 ? null : buckets[selected]?.windows.find(w => w.minutes === 10080) ?? null;
  const credits = record(data.rateLimitResetCredits);
  const count = number(credits.availableCount);
  return {
    buckets, weekly, plan: label(plan), fetchedAt: now,
    resetCount: count !== null && Number.isSafeInteger(count) ? count : null,
    expiries: Array.isArray(credits.credits) ? credits.credits
      .filter(v => record(v).status === "available")
      .map(v => timestamp(record(v).expiresAt)) : [],
  };
}

export function countdown(seconds: number, now: number): string {
  const mins = Math.ceil((seconds * 1000 - now) / 60000);
  if (mins <= 0) return "pending refresh";
  if (mins >= 1440) return `${Math.floor(mins / 1440)}d ${Math.floor(mins % 1440 / 60)}h`;
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${mins}m`;
}
const fullDate = (seconds: number) => new Date(seconds * 1000).toLocaleString(undefined, { timeZoneName: "short" });
export function formatStatus(s: Snapshot, now: number, error?: string): string {
  const w = s.weekly;
  const quota = w?.used === null || !w ? "weekly usage unavailable" : `${w.used}%/wk. used`;
  const reset = w?.reset === null || !w ? "weekly reset unavailable" : `resets in ${countdown(w.reset, now)}`;
  let credits = "usage resets unavailable";
  if (s.resetCount === 0) credits = "no usage reset available";
  else if (s.resetCount !== null) {
    const dates = s.expiries.slice(0, 2).map(t => t === null ? "expiry unknown/none" : new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
    const complete = s.expiries.length === s.resetCount && dates.length === s.resetCount;
    credits = dates.length ? `${complete ? "" : `${s.resetCount} available · `}usage reset expiry dates: ${dates.join(", ")}${complete ? "" : " (partial details)"}` : `${s.resetCount} usage resets available (expiry unavailable)`;
  }
  const stale = error || (w?.reset !== null && w?.reset !== undefined && w.reset * 1000 <= now);
  // Freshness is essential: keep it before all quota/expiry text so Pi's
  // footer truncation cannot make an old snapshot look current.
  return `Codex: ${stale ? `stale (${Math.max(0, Math.floor((now - s.fetchedAt) / 60000))}m old) · ` : ""}${quota} · ${reset} · ${credits}`;
}
export function formatDetails(s: Snapshot, now: number, error?: string): string {
  const lines = [formatStatus(s, now, error), "Source: Codex signed-in account/workspace (may differ from Pi).", `Plan: ${s.plan ?? "unavailable"}`, `Last successful fetch: ${new Date(s.fetchedAt).toLocaleString()}`];
  for (const b of s.buckets) for (const w of b.windows) {
    lines.push(`${b.name} · ${w.minutes === 10080 ? "weekly" : w.minutes === null ? "unknown window" : `${w.minutes}-minute window`}: ${w.used === null ? "usage unavailable" : `${w.used}% used / ${100 - w.used}% remaining`}; reset ${w.reset === null ? "unavailable" : fullDate(w.reset)}`);
  }
  lines.push(`Available usage resets: ${s.resetCount ?? "unavailable"}`);
  if (s.resetCount !== 0) s.expiries.forEach(t => lines.push(`Reset expiry: ${t === null ? "not expiring or unavailable" : fullDate(t)}`));
  if (error) lines.push(`Refresh failed: ${error}`);
  return lines.join("\n");
}

export interface QueryOptions {
  signal?: AbortSignal; timeoutMs?: number;
  start?: () => ChildProcessWithoutNullStreams;
}
export async function queryUsage(options: QueryOptions = {}): Promise<Snapshot> {
  if (options.signal?.aborted) throw new Error("Usage refresh cancelled.");
  const child = (options.start ?? (() => spawn("codex", ["app-server", "--listen", "stdio://"], { stdio: "pipe" })))();
  let closed = false;
  const exited = new Promise<void>(resolve => {
    child.once("close", () => { closed = true; resolve(); });
  });
  let timer: NodeJS.Timeout | undefined;
  let onAbort: () => void = () => {};
  try {
    return await new Promise<Snapshot>((resolve, reject) => {
      let buffer = "", total = 0, phase = 0, plan: unknown, settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true; reject(new Error(message));
      };
      const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
      child.stdin.on("error", () => fail("Codex connection closed; retry usage refresh."));
      child.on("error", () => fail("Cannot start Codex CLI; install it and run codex login."));
      child.on("close", () => fail("Codex exited before returning usage; retry or update Codex."));
      // Drain, but never retain or display potentially sensitive stderr.
      child.stderr.resume();
      onAbort = () => fail("Usage refresh cancelled.");
      options.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => fail("Codex usage request timed out; check login/network and retry."), options.timeoutMs ?? 15000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (settled) return;
        total += Buffer.byteLength(chunk);
        if (total > 1024 * 1024) return fail("Codex response exceeded size limit.");
        buffer += chunk;
        let pos: number;
        while ((pos = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
          if (!line.trim()) continue;
          let msg: Record<string, unknown>;
          try { msg = record(JSON.parse(line)); } catch { return fail("Invalid Codex protocol response; update Codex."); }
          if (msg.id !== phase) continue;
          if (msg.error) return fail("Codex rejected the usage request; check login or update Codex CLI.");
          if (!("result" in msg)) continue;
          if (phase === 0) {
            phase = 1;
            send({ method: "initialized", params: {} });
            send({ id: 1, method: "account/read", params: { refreshToken: false } });
          } else if (phase === 1) {
            const account = record(record(msg.result).account);
            if (account.type !== "chatgpt") return fail("ChatGPT login required: run codex login (API-key quota is unsupported).");
            plan = account.planType; phase = 2;
            send({ id: 2, method: "account/rateLimits/read" });
          } else if (phase === 2) {
            phase = 3;
            try {
              const snapshot = normalize(msg.result, plan);
              settled = true; resolve(snapshot); return;
            } catch { fail("Unsupported Codex quota response; update Codex CLI."); return; }
          }
        }
      });
      send({ id: 0, method: "initialize", params: { clientInfo: { name: "pi_chatgpt_usage", title: "Pi Codex Usage", version: "0.1.0" } } });
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    if (!closed) {
      child.stdin.end(); child.kill("SIGTERM");
      const force = setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 500);
      await exited;
      clearTimeout(force);
    }
  }
}
