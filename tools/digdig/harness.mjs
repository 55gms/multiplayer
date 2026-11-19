// Runs the digdig.io client in headless Chromium against a local handler module.
// Every request the client makes is answered locally: no traffic reaches M28.
//
//   node tools/digdig/harness.mjs <handler.mjs> [--secs S] [--shot file.png]
//
// The handler module may export:
//   onOpen(ws), onMessage(ws, buf)      the game server's side of each WebSocket
//   breaks: { "<func index>": async (bp) => {} }
//                                       Chrome debugger breakpoints at a wasm function's
//                                       first instruction; bp.locals(0, 1) reads its params and
//                                       bp.mem(addr, len) reads wasm memory. Execution resumes
//                                       when the callback returns.
//   drive(page, log)                    keyboard/mouse input after the page loads
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(new URL("../../package.json", import.meta.url));
const { chromium } = require("playwright-core");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const CLIENT = path.join(ROOT, "captures/digdig/client");

const argv = process.argv.slice(2);
const handlerPath = argv.shift();
const opt = { secs: 15, shot: null };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--secs") opt.secs = Number(argv[++i]);
  else if (argv[i] === "--shot") opt.shot = argv[++i];
}
const handler = await import(path.resolve(handlerPath));

const offsets = new Map(
  fs
    .readFileSync(path.join(ROOT, "captures/digdig/offsets.txt"), "utf8")
    .trim()
    .split("\n")
    .map((l) => l.split(" ").map(Number))
    .map(([f, s, e]) => [f, [s, e]]),
);

const pw = fs.readdirSync(`${process.env.HOME}/.cache/ms-playwright`).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/${pw}/chrome-linux64/chrome`,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
// Keep the wasm memory reachable for the debugger hooks.
await ctx.addInitScript(() => {
  const keep = (r) => {
    const inst = r.instance || r;
    window.__ddexp = inst.exports;
    for (const v of Object.values(inst.exports)) if (v instanceof WebAssembly.Memory) window.__ddmem = v;
    return r;
  };
  const a = WebAssembly.instantiate;
  WebAssembly.instantiate = (...x) => a.apply(WebAssembly, x).then(keep);
  const b = WebAssembly.instantiateStreaming;
  if (b) WebAssembly.instantiateStreaming = (...x) => b.apply(WebAssembly, x).then(keep);
});
// Probe hits are batched to the console as "PROBE tag value extra" lines.
await ctx.addInitScript(() => {
  let q = [];
  window.__ddprobe = (a, b, c) => {
    q.push(`${a} ${b} ${c}`);
    if (q.length === 1) setTimeout(() => { console.log("PROBE " + q.join("\nPROBE ")); q = []; }, 0);
  };
});
const page = await ctx.newPage();
const t0 = Date.now();
const log = (...a) => console.log(String(Date.now() - t0).padStart(6), ...a);

const json = (body) => ({ contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
const SERVER = { id: "test", ipv4: "127.0.0.1", ipv6: "::1" };
await ctx.route(/./, async (r) => {
  const u = new URL(r.request().url());
  if (u.hostname === "digdig.io" && u.pathname === "/") return r.fulfill({ contentType: "text/html", body: fs.readFileSync(path.join(CLIENT, "index.html")) });
  if (u.hostname === "static.digdig.io") {
    let f = path.join(CLIENT, path.basename(u.pathname));
    // DD_WASM serves a patched client (tools/digdig/patch.py) in place of the real one
    if (f.endsWith(".wasm") && process.env.DD_WASM) f = path.resolve(process.env.DD_WASM);
    const type = f.endsWith(".wasm") ? "application/wasm" : f.endsWith(".js") ? "text/javascript" : "font/ttf";
    if (f.endsWith("client.js")) {
      // EM_ASM code 999000 is the probes' way out: (tag, value, extra)
      const js = fs.readFileSync(f, "utf8").replace("117689:(a,b,c)=>", "999000:(a,b,c)=>{window.__ddprobe&&window.__ddprobe(a,b,c);return 0},117689:(a,b,c)=>");
      return r.fulfill({ body: js, contentType: type });
    }
    if (fs.existsSync(f)) return r.fulfill({ body: fs.readFileSync(f), contentType: type });
  }
  if (u.hostname === "api.n.m28.io") {
    if (u.pathname.startsWith("/endpoint/")) return r.fulfill(json({ servers: { "vultr-chicago": SERVER } }));
    if (u.pathname.startsWith("/server/")) return r.fulfill(json(SERVER));
  }
  if (u.hostname.endsWith("digdig.io")) return r.fulfill({ status: 404, body: "" });
  return r.abort();
});

let conns = 0;
await page.routeWebSocket(/./, (ws) => {
  const id = ++conns;
  const api = {
    id,
    url: ws.url(),
    send(buf) {
      buf = Buffer.from(buf);
      if (!handler.quiet) log(`WS#${id} <`, buf.length, buf.toString("hex").slice(0, 240));
      ws.send(buf);
    },
    close: () => ws.close(),
    log: (...a) => log(`WS#${id}`, ...a),
  };
  log(`WS#${id} open ${api.url}`);
  ws.onMessage((m) => {
    const b = Buffer.from(m);
    if (!handler.quiet) log(`WS#${id} >`, b.length, b.toString("hex").slice(0, 240));
    handler.onMessage?.(api, b);
  });
  ws.onClose(() => log(`WS#${id} closed by client`));
  handler.onOpen?.(api);
});
page.on("console", (m) => log("console:", m.text().slice(0, 400)));
page.on("pageerror", (e) => log("pageerror:", e.message.slice(0, 400)));

if (handler.breaks) {
  const cdp = await ctx.newCDPSession(page);
  let wasmScript = null;
  const ready = new Promise((res) => {
    cdp.on("Debugger.scriptParsed", (s) => {
      if (s.scriptLanguage === "WebAssembly" || s.url.endsWith(".wasm")) {
        wasmScript = s.scriptId;
        res();
      }
    });
  });
  const byLocation = new Map();
  cdp.on("Debugger.paused", async (ev) => {
    const frame = ev.callFrames[0];
    const fn = byLocation.get(ev.hitBreakpoints?.[0]);
    try {
      if (fn) {
        await fn({
          frame,
          frames: ev.callFrames,
          // wasm locals by index: params first, then declared locals
          async locals(...idx) {
            const expression = `[${idx.map((i) => `$var${i}.value`).join(",")}]`;
            const r = await cdp.send("Debugger.evaluateOnCallFrame", { callFrameId: frame.callFrameId, expression, returnByValue: true });
            return r.result.value;
          },
          async mem(addr, len) {
            const { result } = await cdp.send("Runtime.evaluate", {
              expression: `Array.from(new Uint8Array(window.__ddmem.buffer, ${addr >>> 0}, ${len >>> 0}))`,
              returnByValue: true,
            });
            return Buffer.from(result.value || []);
          },
          async write(addr, bytes) {
            await cdp.send("Runtime.evaluate", {
              expression: `new Uint8Array(window.__ddmem.buffer, ${addr >>> 0}, ${bytes.length}).set(${JSON.stringify([...bytes])})`,
            });
          },
          log,
          cdp,
        });
      }
    } catch (e) {
      log("break handler error:", e.message);
    }
    await cdp.send("Debugger.resume").catch(() => {});
  });
  await cdp.send("Debugger.enable");
  page.goto("https://digdig.io/").catch(() => {});
  await ready;
  for (const [f, fn] of Object.entries(handler.breaks)) {
    const [start] = offsets.get(Number(f));
    const { breakpointId } = await cdp.send("Debugger.setBreakpoint", { location: { scriptId: wasmScript, lineNumber: 0, columnNumber: start } }).catch((e) => {
      log(`breakpoint f${f} failed: ${e.message}`);
      return {};
    });
    if (breakpointId) byLocation.set(breakpointId, fn);
  }
} else {
  await page.goto("https://digdig.io/");
}
if (handler.drive) await handler.drive(page, log);
await page.waitForTimeout(opt.secs * 1000);
if (opt.shot) await page.screenshot({ path: opt.shot, timeout: 5000 }).catch(() => log("screenshot timed out"));
await browser.close();
