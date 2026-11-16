// Opens a game page in headless Chromium and logs its Photon traffic, for
// working out what a client expects. Not a test.
//
//   CHROME_PATH=/path/to/chrome node tools/capture.mjs <url> [options]
//     --pages N          open N pages (players) at once (default 1)
//     --secs S           how long to watch (default 60)
//     --mp BASE          set localStorage gms-mp-base (e.g. ws://localhost:8093/api/mp)
//     --click X,Y@S      click at X,Y (1280x720 viewport) S seconds in; repeatable
//     --stagger MS       delay between opening pages (default 0)
//     --close-at P@S     close page P (1-based) S seconds in
//     --shots DIR        save a screenshot per page at the end (default captures/)
//     --hex              print frame bytes as well as their summary
//     --size WxH         viewport (default 1280x720; clicks are given in 1280x720
//                        and scaled, so a small window renders faster on software GL)
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const url = args.shift();
if (!url) {
  console.error("usage: node tools/capture.mjs <url> [--pages N] [--secs S] [--mp BASE] [--click X,Y@S] [--shots DIR]");
  process.exit(1);
}
const opt = { pages: 1, secs: 60, mp: null, clicks: [], stagger: 0, closes: [], shots: "captures", hex: false, w: 1280, h: 720 };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--pages") opt.pages = Number(args[++i]);
  else if (a === "--secs") opt.secs = Number(args[++i]);
  else if (a === "--mp") opt.mp = args[++i];
  else if (a === "--stagger") opt.stagger = Number(args[++i]);
  else if (a === "--shots") opt.shots = args[++i];
  else if (a === "--hex") opt.hex = true;
  else if (a === "--size") [opt.w, opt.h] = args[++i].split("x").map(Number);
  else if (a === "--click") {
    const [xy, at] = args[++i].split("@");
    const [x, y] = xy.split(",").map(Number);
    opt.clicks.push({ x, y, at: Number(at) });
  } else if (a === "--close-at") {
    const [p, at] = args[++i].split("@");
    opt.closes.push({ page: Number(p), at: Number(at) });
  }
}

const NAMES = {
  op: { 1: "Ping", 217: "GetGameList", 218: "ServerSettings", 220: "GetRegions", 221: "GetLobbyStats", 222: "FindFriends", 225: "JoinRandomGame", 226: "JoinGame", 227: "CreateGame", 228: "LeaveLobby", 229: "JoinLobby", 230: "Authenticate", 231: "AuthenticateOnce", 248: "ChangeGroups", 251: "GetProperties", 252: "SetProperties", 253: "RaiseEvent", 254: "Leave" },
  ev: { 255: "Join", 254: "Leave", 253: "PropertiesChanged", 230: "GameList", 229: "GameListUpdate", 226: "AppStats", 224: "LobbyStats", 200: "RPC", 201: "Serialize", 202: "Instantiate", 204: "Destroy", 206: "SerializeReliable", 207: "DestroyPlayer", 209: "OwnershipRequest", 210: "OwnershipTransfer", 212: "OwnershipUpdate" },
};

function describe(buf) {
  if (buf.length < 3 || buf[0] !== 0xf3) return `? ${buf.subarray(0, 24).toString("hex")}`;
  const type = buf[1] & 0x7f;
  const code = buf[2];
  if (type === 1) return "InitResponse";
  if (type === 2) return `Op ${NAMES.op[code] || code}`;
  if (type === 6 || type === 7) return `Internal ${type === 6 ? "req" : "resp"} ${code}`;
  if (type === 3) return `Response ${NAMES.op[code] || code} rc=${buf.readInt16LE(3)}`;
  if (type === 4) return `Event ${NAMES.ev[code] || code}`;
  return `type ${type} code ${code}`;
}

// One browser per player, so no page is a throttled background tab.
const launch = () =>
  chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
    ],
  });
const browsers = [];
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
const pages = [];

async function openPage(n) {
  const tag = `p${n}`;
  const browser = await launch();
  browsers.push(browser);
  const context = await browser.newContext({ viewport: { width: opt.w, height: opt.h } });
  if (opt.mp) await context.addInitScript((base) => localStorage.setItem("gms-mp-base", base), opt.mp);
  const page = await context.newPage();
  const say = (s) => console.log(`${ts()} ${tag} ${s}`);
  page.on("websocket", (ws) => {
    const short = ws.url().replace(/^wss?:\/\/[^/]+/, "");
    say(`WS open ${ws.url()}`);
    ws.on("framesent", (f) => {
      const b = Buffer.from(f.payload);
      if (b[1] === 6) return; // pings
      say(`  > ${short} ${describe(b)}${opt.hex ? " " + b.subarray(0, 96).toString("hex") : ""}`);
    });
    ws.on("framereceived", (f) => {
      const b = Buffer.from(f.payload);
      if (b[1] === 7) return;
      say(`  < ${short} ${describe(b)}${opt.hex ? " " + b.subarray(0, 96).toString("hex") : ""}`);
    });
    ws.on("close", () => say(`WS close ${short}`));
    ws.on("socketerror", (e) => say(`WS error ${short} ${e}`));
  });
  page.on("console", (m) => {
    const t = m.text();
    if (/photon|connect|server|region|room|lobby|join|match|exception|error|failed/i.test(t) && !/analytics|cpmstar|gtag/i.test(t)) say(`console: ${t.split("\n")[0].slice(0, 240)}`);
  });
  page.on("requestfailed", (r) => {
    if (!/analytics|googletag|cpmstar|doubleclick|imasdk/.test(r.url())) say(`FAILED ${r.url().slice(0, 140)} ${r.failure()?.errorText}`);
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  pages.push({ tag, page, context });
}

const opening = [];
for (let i = 1; i <= opt.pages; i++) {
  opening.push(openPage(i));
  if (opt.stagger) await new Promise((r) => setTimeout(r, opt.stagger));
}
await Promise.all(opening);

const timers = [];
for (const c of opt.clicks) {
  timers.push(
    new Promise((r) =>
      setTimeout(async () => {
        await Promise.all(
          pages.map(async ({ tag, page }) => {
            if (page.isClosed()) return;
            console.log(`${ts()} ${tag} click ${c.x},${c.y}`);
            await page.mouse.click((c.x * opt.w) / 1280, (c.y * opt.h) / 720).catch(() => {});
          }),
        );
        r();
      }, c.at * 1000),
    ),
  );
}
for (const c of opt.closes) {
  timers.push(
    new Promise((r) =>
      setTimeout(async () => {
        const p = pages[c.page - 1];
        if (p) {
          await p.context.close();
          console.log(`${ts()} ${p.tag} closed`);
        }
        r();
      }, c.at * 1000),
    ),
  );
}

await new Promise((r) => setTimeout(r, opt.secs * 1000));
fs.mkdirSync(opt.shots, { recursive: true });
await Promise.all(
  pages.map(async ({ tag, page }) => {
    if (page.isClosed()) return;
    const file = path.join(opt.shots, `${tag}.png`);
    await page.screenshot({ path: file, timeout: 15000 }).catch(() => {});
    console.log(`${ts()} ${tag} screenshot ${file}`);
  }),
);
await Promise.all(browsers.map((b) => b.close()));
