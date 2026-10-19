import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
const browser = spawn(
  "chromium",
  [
    "--headless",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--disable-background-networking",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9222",
    "about:blank",
  ],
  { stdio: "ignore" },
);
let socket;
const timeout = setTimeout(() => {
  browser.kill("SIGKILL");
  process.exit(1);
}, 30000);
try {
  let tab;
  for (let i = 0; i < 100; i++) {
    try {
      const tabs = await (await fetch("http://127.0.0.1:9222/json")).json();
      tab = tabs.find((t) => t.type === "page");
      if (tab) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!tab) throw new Error("Navigateur indisponible");
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const pending = new Map(),
    errors = [];
  socket.addEventListener("message", ({ data }) => {
    const m = JSON.parse(data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
    }
    if (m.method === "Runtime.exceptionThrown")
      errors.push(m.params.exceptionDetails.text || "Erreur JavaScript");
    if (
      m.method === "Log.entryAdded" &&
      m.params.entry.level === "error" &&
      !m.params.entry.url?.endsWith("/favicon.ico")
    )
      errors.push(m.params.entry.text.slice(0, 300));
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      socket.send(JSON.stringify({ id: n, method, params }));
    });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  for (const [name, width, height, mobile] of [
    ["desktop", 1440, 1000, false],
    ["mobile", 390, 844, true],
  ]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile,
    });
    const loaded = new Promise((resolve) => {
      const listen = ({ data }) => {
        if (JSON.parse(data).method === "Page.loadEventFired") {
          socket.removeEventListener("message", listen);
          resolve();
        }
      };
      socket.addEventListener("message", listen);
    });
    const nav = await send("Page.navigate", {
      url: process.env.ATELIER_QA_URL,
    });
    if (nav.errorText) throw Error(nav.errorText);
    await loaded;
    await new Promise((r) => setTimeout(r, 750));
    const shot = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(`/shots/${name}.png`, Buffer.from(shot.data, "base64"));
  }
  const content = await send("Runtime.evaluate", {
    expression:
      "JSON.stringify({title:document.title,text:document.body?.innerText?.slice(0,1000),overflow:document.documentElement.scrollWidth>innerWidth})",
    returnByValue: true,
  });
  const report = {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    page: JSON.parse(content.result.value || "{}"),
  };
  await writeFile("/shots/report.json", JSON.stringify(report));
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
} catch (e) {
  console.log(JSON.stringify({ ok: false, errors: [e.message] }));
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  socket?.close();
  browser.kill("SIGKILL");
}
