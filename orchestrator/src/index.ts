import { cfg, getProjects } from "./config.ts";
import { failOrphans, purgeExpiredSessions } from "./db.ts";
import { bootstrapOwner } from "./bootstrap.ts";
import { startProxy } from "./proxy.ts";
import { createApp } from "./app.ts";

failOrphans();
purgeExpiredSessions();
await bootstrapOwner();
createApp().listen(cfg.port, () => console.log(`atelier sur :${cfg.port} — ${getProjects().length} projet(s)`));
startProxy();
