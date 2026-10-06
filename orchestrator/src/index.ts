import { cfg } from "./config.ts";
import { countProjects, failOrphans, purgeExpiredSessions } from "./db.ts";
import { bootstrapOwner, importLegacyConfig } from "./bootstrap.ts";
import { startProxy } from "./proxy.ts";
import { createApp } from "./app.ts";
import { startMonitor } from "./monitor.ts";
import { sweepEditor } from "./editor.ts";

failOrphans();
purgeExpiredSessions();
await bootstrapOwner();
importLegacyConfig();
createApp().listen(cfg.port, () => console.log(`atelier sur :${cfg.port} — ${countProjects()} projet(s)`));
startProxy();
startMonitor();
void sweepEditor();
setInterval(() => void sweepEditor(), 5 * 60_000).unref(); // sessions d'édition inactives et dossiers orphelins
