import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { queryUsage, formatStatus, formatDetails, type Snapshot } from "./usage.ts";

const KEY = "pi-chatgpt-usage";
export function registerUsage(pi: ExtensionAPI, query = queryUsage, now = Date.now) {
  let context: ExtensionContext | undefined;
  let snapshot: Snapshot | undefined;
  let error: string | undefined;
  let pending: Promise<void> | undefined;
  let abort: AbortController | undefined;
  let generation = 0;
  let cleanup: Promise<void> = Promise.resolve();
  let poll: NodeJS.Timeout | undefined, tick: NodeJS.Timeout | undefined;
  const render = () => {
    if (!context) return;
    const text = snapshot ? formatStatus(snapshot, now(), error) : `Codex: ${error ?? "loading usage…"}`;
    // Compute styling afresh so theme changes never leave cached ANSI state.
    context.ui.setStatus(KEY, context.ui.theme.fg(error ? "warning" : "dim", text));
  };
  const stop = (): Promise<void> => {
    generation++;
    clearInterval(poll); clearInterval(tick);
    const owned = pending;
    abort?.abort(); abort = undefined; pending = undefined;
    context?.ui.setStatus(KEY, undefined); context = undefined;
    snapshot = undefined; error = undefined;
    // Pi awaits shutdown handlers before exiting. Keep ownership until the
    // query's finally block has terminated and reaped its child, even on reload.
    cleanup = Promise.all([cleanup, owned]).then(() => {});
    return cleanup;
  };
  const refresh = (): Promise<void> => {
    if (!context) return Promise.resolve();
    if (pending) return pending;
    const current = generation;
    abort = new AbortController();
    pending = (async () => {
      try {
        const result = await query({ signal: abort!.signal });
        if (current === generation) { snapshot = result; error = undefined; }
      } catch (e) {
        if (current === generation) error = e instanceof Error ? e.message : "Usage unavailable; retry refresh.";
      } finally {
        if (current === generation) { pending = undefined; abort = undefined; render(); }
      }
    })();
    return pending;
  };
  pi.on("session_start", async (_event, ctx) => {
    const stopped = stop();
    const current = generation;
    await stopped;
    if (current !== generation || ctx.mode !== "tui") return;
    context = ctx; render(); void refresh();
    poll = setInterval(() => { void refresh(); }, 5 * 60000); poll.unref();
    tick = setInterval(render, 60000); tick.unref();
  });
  pi.on("session_shutdown", stop);
  pi.registerCommand("chatgpt-usage", {
    description: "Show Codex quota/reset details; add 'refresh' to fetch now",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;
      if (args.trim() && args.trim() !== "refresh") {
        ctx.ui.notify("Usage: /chatgpt-usage [refresh]", "warning"); return;
      }
      const current = generation;
      if (args.trim() === "refresh" || !snapshot) await refresh();
      if (current !== generation || !context) return;
      ctx.ui.notify(snapshot ? formatDetails(snapshot, now(), error) : `Codex: ${error ?? "usage unavailable"}`, error ? "warning" : "info");
    },
  });
}
export default function (pi: ExtensionAPI) { registerUsage(pi); }
