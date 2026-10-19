import { startHuman } from "./human.ts";
import { resumeQueuedTasks } from "./pipeline.ts";
import { startAutomations } from "./automations.ts";
import { startNotifications, notifyTask } from "./notifications.ts";
import { startAppsGateway, startReleases, sweepReleases } from "./releases.ts";
import { stopOrphanContainers } from "./sandbox.ts";
import { cfg } from "./config.ts";
import { countProjects, failOrphans, purgeExpiredSessions } from "./db.ts";
import { bootstrapOwner, importLegacyConfig } from "./bootstrap.ts";
import { startProxy } from "./proxy.ts";
import { createApp } from "./app.ts";
import { startMonitor } from "./monitor.ts";
import { sweepEditor } from "./editor.ts";
import { trustLocalRepos, cleanup } from "./git.ts";

import { recoverBudgets } from "./budget.ts";

recoverBudgets();
trustLocalRepos();
await stopOrphanContainers();
for (const id of failOrphans()) { await cleanup(id); notifyTask(id); }
purgeExpiredSessions();
await bootstrapOwner();
importLegacyConfig();
createApp().listen(cfg.port, () => console.log(`atelier sur :${cfg.port} — ${countProjects()} projet(s)`));
startProxy();
startMonitor();
void sweepEditor();
setInterval(() => void sweepEditor(), 5 * 60_000).unref(); // sessions d'édition inactives et dossiers orphelins

resumeQueuedTasks();
startAutomations();
startHuman();
startNotifications();
startReleases();
startAppsGateway();
void sweepReleases().catch(() => console.warn("release: nettoyage indisponible"));
setInterval(() => void sweepReleases().catch(() => console.warn("release: nettoyage indisponible")), 5 * 60_000).unref();
