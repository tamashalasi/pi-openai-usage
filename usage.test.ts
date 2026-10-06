import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalize, formatStatus, formatDetails, countdown, queryUsage, type Snapshot } from "./usage.ts";
import { registerUsage } from "./index.ts";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
const now = Date.UTC(2026, 9, 10);
const window = { usedPercent: 37, windowDurationMins: 10080, resetsAt: now / 1000 + 187200 };
const fixture = (credits: unknown = { availableCount: 2, credits: [
  { status: "available", expiresAt: Date.UTC(2026, 9, 12) / 1000 },
  { status: "available", expiresAt: Date.UTC(2026, 9, 23) / 1000 },
] }) => ({ rateLimits: { primary: null, secondary: window }, rateLimitResetCredits: credits });

test("weekly usage, requested wording, expiry dates and full details", () => {
  const s = normalize(fixture(), "plus", now);
  assert.equal(formatStatus(s, now), "Codex: 37%/wk. used · resets in 2d 4h · usage reset expiry dates: Oct 12, Oct 23");
  assert.doesNotMatch(formatStatus(s, now), /2 available/);
  assert.match(formatDetails(s, now), /Available usage resets: 2/);
  assert.match(formatDetails(s, now), /63% remaining/);
  assert.match(formatDetails(s, now), /UTC/);
  assert.equal(countdown(now / 1000 - 1, now), "pending refresh");
});
test("weekly in either position and prefer codex, preserve distinct buckets", () => {
  const s = normalize({ rateLimitsByLimitId: {
    other: { primary: window }, codex: { primary: window, secondary: { ...window, windowDurationMins: 300 } },
  } }, "pro", now);
  assert.equal(s.buckets.length, 2); assert.equal(s.buckets[0].name, "codex");
  assert.equal(s.weekly?.used, 37);
  assert.equal(normalize({ rateLimitsByLimitId: { other: { primary: window } } }, null).weekly, null);
  assert.equal(normalize({ rateLimits: { limitId: "other", primary: window } }, null).weekly, null);
  const fallback = normalize({ rateLimits: { limitId: "codex", secondary: window }, rateLimitsByLimitId: { other: { primary: { ...window, usedPercent: 80 } } } }, null, now);
  assert.equal(fallback.weekly?.used, 37); assert.equal(fallback.buckets.length, 2);
  assert.match(formatDetails(fallback, now), /other/);
});
test("footer truncation preserves stale age and cached quota with neighbor status", () => {
  const s = normalize(fixture(), null, now - 7 * 60000);
  for (const width of [80, 120]) {
    const line = truncateToWidth(`NEIGHBOR ${formatStatus(s, now, "Network unavailable")}`, width, "...");
    assert.ok(visibleWidth(line) <= width);
    assert.match(line, /Codex: stale \(7m old\)/);
    assert.match(line, /37%\/wk\. used/);
    assert.match(line, /^NEIGHBOR/);
  }
});
test("status bounds expiry list and states authoritative count for partial details", () => {
  const rows = Array.from({ length: 100 }, () => ({ status: "available", expiresAt: Date.UTC(2026, 9, 12) / 1000 }));
  const text = formatStatus(normalize(fixture({ availableCount: 100, credits: rows }), null, now), now);
  assert.equal((text.match(/Oct 12/g) ?? []).length, 2); // two expiry dates
  assert.match(text, /100 available · usage reset expiry dates: .*\(partial details\)/);
  assert.ok(text.length < 230);
});
test("unknown vs zero/count-only/capped reset details", () => {
  assert.match(formatStatus(normalize(fixture(null), null, now), now), /usage resets unavailable/);
  assert.match(formatStatus(normalize(fixture({ availableCount: 0 }), null, now), now), /no usage reset available/);
  assert.match(formatStatus(normalize(fixture({ availableCount: 5, credits: null }), null, now), now), /5 usage resets available/);
  assert.match(formatStatus(normalize(fixture({ availableCount: 5, credits: [{ status: "available", expiresAt: null }] }), null, now), now), /5 available · usage reset expiry dates: .*\(partial details\)/);
  assert.equal(normalize(fixture({ availableCount: -1 }), null).resetCount, null);
});
test("missing/invalid fields and past reset never imply fresh quota", () => {
  for (const used of [0, 100, -1, 101, Infinity, NaN, null]) {
    const s = normalize({ rateLimits: { primary: { ...window, usedPercent: used, resetsAt: now / 1000 - 1 } } }, null, now);
    assert.equal(s.weekly?.used, used === 0 || used === 100 ? used : null);
    assert.match(formatStatus(s, now), /stale/);
  }
  assert.equal(normalize({ rateLimits: { secondary: { usedPercent: 10 } } }, null).weekly, null);
  assert.equal(normalize({ rateLimits: null }, null).weekly, null);
  assert.throws(() => normalize({}, null), /Unsupported/);
  assert.doesNotMatch(formatDetails(normalize({ rateLimitsByLimitId: { codex: { limitName: "\x1b[31msecret\n", primary: window } } }, null), now), /\x1b/);
});

// Real child processes exercise framing and ensure termination, without Codex/auth/network.
function fake(mode: string) {
  let child: ReturnType<typeof spawn>;
  const start = () => {
    child = spawn(process.execPath, ["--input-type=module", "-e", `
      import readline from 'node:readline';
      const mode=${JSON.stringify(mode)};
      const rl=readline.createInterface({input:process.stdin});
      rl.on('line',line=>{
        const m=JSON.parse(line);
        if(m.method==='initialized') return;
        if(!['initialize','account/read','account/rateLimits/read'].includes(m.method)) process.exit(9);
        if(mode==='hang' || mode==='ignoreterm') return;
        if(mode==='exit') process.exit(1);
        if(mode==='malformed') {process.stdout.write('bad\\n');return;}
        if(mode==='oversize') {process.stdout.write('x'.repeat(1100000));return;}
        if(mode==='rpc') {process.stdout.write(JSON.stringify({id:m.id,error:{message:'SECRET'}})+'\\n');return;}
        const result=m.id===0?{}:m.id===1?{account:{type:mode==='apikey'?'apiKey':'chatgpt',planType:'plus',email:'SECRET'}}:${JSON.stringify(fixture())};
        const data=JSON.stringify({method:'unrelated'})+'\\n'+JSON.stringify({id:999,result:{}})+'\\n'+JSON.stringify({id:m.id,result})+'\\n';
        process.stdout.write(data.slice(0,5));setTimeout(()=>process.stdout.write(data.slice(5)),2);
      });
      if(mode==='ignoreterm') process.on('SIGTERM',()=>{});
      setInterval(()=>{},1000);
    `], { stdio: "pipe" });
    return child as import("node:child_process").ChildProcessWithoutNullStreams;
  };
  return { start, get child() { return child!; } };
}
test("RPC handshake tolerates chunking and notifications and reaps child", async () => {
  const f = fake("ok"); const s = await queryUsage({ start: f.start });
  assert.equal(s.weekly?.used, 37); assert.notEqual(f.child.signalCode, null);
});
for (const [mode, message] of [["apikey", /login required/], ["rpc", /rejected/], ["malformed", /Invalid/], ["exit", /exited/], ["oversize", /size limit/], ["hang", /timed out/]] as const) {
  test(`RPC ${mode} is sanitized and child closed`, async () => {
    const f = fake(mode);
    await assert.rejects(queryUsage({ start: f.start, timeoutMs: 300 }), message);
    assert.ok(f.child.exitCode !== null || f.child.signalCode !== null);
  });
}
test("missing CLI and cancellation", async () => {
  await assert.rejects(queryUsage({ start: () => spawn("/nonexistent/codex", [], { stdio: "pipe" }) }), /Cannot start/);
  const f = fake("hang"), abort = new AbortController();
  const result = queryUsage({ start: f.start, signal: abort.signal });
  abort.abort(); await assert.rejects(result, /cancelled/);
  assert.notEqual(f.child.signalCode, null);
  await assert.rejects(queryUsage({ signal: abort.signal }), /cancelled/);
});

function harness(query: typeof queryUsage) {
  const events = new Map<string, Function>();
  let handler: Function;
  const statuses: (string | undefined)[] = [], notifications: string[] = [];
  const pi = { on: (name: string, fn: Function) => events.set(name, fn), registerCommand: (_name: string, spec: { handler: Function }) => { handler = spec.handler; } };
  const ctx = { mode: "tui", ui: { setStatus: (_key: string, text?: string) => statuses.push(text), theme: { fg: (_color: string, text: string) => text }, notify: (text: string) => notifications.push(text) } };
  registerUsage(pi as unknown as ExtensionAPI, query, () => now);
  return { events, ctx, statuses, notifications, command: (args: string) => handler(args, ctx) };
}
test("force-kills a child that ignores termination", async () => {
  const f = fake("ignoreterm");
  await assert.rejects(queryUsage({ start: f.start, timeoutMs: 300 }), /timed out/);
  assert.equal(f.child.signalCode, "SIGKILL");
});
const flush = () => new Promise(resolve => setImmediate(resolve));
test("lifecycle single-flight, stale cache, cleanup and late callbacks", async () => {
  let calls = 0, resolve!: (s: Snapshot) => void;
  let signal: AbortSignal | undefined;
  const h = harness(async options => { calls++; signal = options?.signal; return new Promise(r => { resolve = r; }); });
  await h.events.get("session_start")!({}, h.ctx);
  const command = h.command("refresh"); assert.equal(calls, 1);
  resolve(normalize(fixture(), null, now)); await command;
  assert.match(h.notifications[0], /Last successful fetch/);
  const pending = h.command("refresh"); assert.equal(calls, 2);
  const shutdown = h.events.get("session_shutdown")!(); assert.equal(signal?.aborted, true);
  const size = h.statuses.length;
  resolve(normalize(fixture(), null, now)); await pending; await shutdown;
  assert.equal(h.statuses.length, size); assert.equal(h.statuses.at(-1), undefined);
});
for (const replacement of [false, true]) test(`lifecycle awaits real termination-resistant child: ${replacement ? "replacement" : "shutdown"}`, async () => {
  const f = fake("ignoreterm"); let calls = 0;
  const h = harness(options => ++calls === 1 ? queryUsage({ ...options, start: f.start }) : Promise.resolve(normalize(fixture(), null, now)));
  await h.events.get("session_start")!({}, h.ctx);
  await new Promise(r => setTimeout(r, 150)); // let the synthetic server install its SIGTERM handler
  let completed = false;
  const ending = (replacement ? h.events.get("session_start")!({}, h.ctx) : h.events.get("session_shutdown")!()).then(() => { completed = true; });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(completed, false); assert.equal(f.child.signalCode, null);
  await ending;
  assert.equal(f.child.signalCode, "SIGKILL");
  if (replacement) { await flush(); assert.equal(calls, 2); }
  await h.events.get("session_shutdown")!();
});
test("five-minute polling, one-minute redraw and theme updates stop at shutdown", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const h = harness(async () => { calls++; return normalize(fixture(), null, now); });
  await h.events.get("session_start")!({}, h.ctx); await flush();
  h.ctx.ui.theme.fg = (_color, text) => `new-theme:${text}`;
  t.mock.timers.tick(60000);
  assert.equal(calls, 1); assert.match(h.statuses.at(-1)!, /^new-theme:/);
  t.mock.timers.tick(240000); await flush(); assert.equal(calls, 2);
  await h.events.get("session_shutdown")!(); const size = h.statuses.length;
  t.mock.timers.tick(600000); await flush();
  assert.equal(calls, 2); assert.equal(h.statuses.length, size);
});
test("failed refresh preserves stale snapshot; mode guard and usage command", async () => {
  let calls = 0;
  const h = harness(async () => { if (++calls === 2) throw new Error("Network unavailable"); return normalize(fixture(), null, now); });
  await h.events.get("session_start")!({}, { ...h.ctx, mode: "rpc" } as unknown as ExtensionContext);
  assert.equal(calls, 0);
  await h.events.get("session_start")!({}, h.ctx); await flush();
  await h.command("refresh"); assert.match(h.statuses.at(-1)!, /stale/);
  assert.match(h.notifications.at(-1)!, /Network unavailable/);
  await h.command("invalid"); assert.match(h.notifications.at(-1)!, /Usage:/);
  await h.events.get("session_shutdown")!(); await h.events.get("session_shutdown")!();
});
