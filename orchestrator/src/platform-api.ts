import { humanApi } from "./human.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  db,
  roleOf,
  getProjectInOrg,
  getTaskInOrg,
  getConversationFor,
  getEvents,
  updateProject,
  updateTask,
  type User,
} from "./db.ts";
import { can, type Action } from "./access.ts";
import { audit } from "./audit.ts";
import { body, HttpError, json } from "./http.ts";
import { vapidKeys, listNotifications, subscribe } from "./notifications.ts";
import {
  getAutomation,
  listAutomations,
  runAutomation,
  saveAutomation,
} from "./automations.ts";
import {
  issuePreviewAccess,
  appsDomain,
  getRelease,
  listReleases,
  productionUrl,
  publishRelease,
  queueRelease,
  releaseDir,
  releaseJson,
  rollbackRelease,
  runtimeOf,
  setEnvironment,
  validateRuntime,
} from "./releases.ts";
import { scaffold, TEMPLATES } from "./scaffold.ts";
import { rowToJson, rowToProject } from "./projects.ts";
import { retryProposal } from "./git.ts";
import { startTask } from "./start.ts";
import { overBudget } from "./budget.ts";
import { taskLogRedactor } from "./security.ts";

export async function platformApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  user: User,
  ip: string,
  sessionToken: string,
): Promise<boolean> {
  if(await humanApi(req,res,url,user))return true;
  const path = url.pathname;
  if (path === "/api/me/notifications" && req.method === "GET") {
    json(res, 200, listNotifications(user.id));
    return true;
  }
  if (path === "/api/me/notifications/read" && req.method === "POST") {
    const b = await body(req);
    if (b.id !== undefined && !Number.isSafeInteger(b.id))
      throw new HttpError(400, "Identifiant invalide.");
    db.prepare(
      `update notifications set read_at=? where user_id=?${b.id === undefined ? "" : " and id=?"}`,
    ).run(Date.now(), user.id, ...(b.id === undefined ? [] : [b.id]));
    json(res, 200, { ok: true });
    return true;
  }
  if (path === "/api/me/push" && req.method === "GET") {
    json(res, 200, { publicKey: vapidKeys().publicKey });
    return true;
  }
  if (path === "/api/me/push" && req.method === "POST") {
    try {
      subscribe(user.id, await body(req));
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    json(res, 201, { ok: true });
    return true;
  }
  if (path === "/api/me/push" && req.method === "DELETE") {
    const b = await body(req);
    if (typeof b.endpoint !== "string")
      throw new HttpError(400, "Abonnement requis.");
    db.prepare(
      "delete from push_subscriptions where endpoint=? and user_id=?",
    ).run(b.endpoint, user.id);
    json(res, 200, { ok: true });
    return true;
  }
  const match =
    /^\/api\/orgs\/([0-9a-f]{16})\/(automations|projects|releases|tasks)(?:\/([0-9a-f]{8,16}|scaffold|templates))?(?:\/(runtime|environment|releases|run|publish|rollback|resume|access|report|logs|desktop.png|mobile.png))?$/.exec(
      path,
    );
  if (!match) return false;
  const [, org, kind, id, sub] = match;
  if (!(
    kind === "automations" ||
    kind === "releases" ||
    (kind === "projects" && (id === "scaffold" || id === "templates" || sub)) ||
    (kind === "tasks" && (sub === "resume" || sub === "logs"))
  ))
    return false;
  const role = roleOf(org!, user.id);
  if (!role) throw new HttpError(404, "Introuvable.");
  const gate = (action: Action) => {
    if (!can(role, action)) throw new HttpError(403, "Droits insuffisants.");
  };
  const log = (
    action: string,
    targetId: string,
    meta?: Parameters<typeof audit>[3],
  ) =>
    audit(
      { orgId: org!, userId: user.id, ip },
      action,
      { type: kind, id: targetId },
      meta,
    );
  if (kind === "tasks" && sub === "logs" && req.method === "GET") {
    gate("task:read");
    const task = getTaskInOrg(id!, org!);
    if (!task) throw new HttpError(404, "Tâche introuvable.");
    const redact = await taskLogRedactor(org!);
    const events = getEvents(task.id).map(e => {
      let text=e.text;
      if(e.type.startsWith("command_"))try {
        const c=JSON.parse(text);
        if(e.type==="command_start" && typeof c.command==="string")text=`${typeof c.source==="string"?c.source:"Commande"}\n$ ${c.command}`;
        if(e.type==="command_result" && typeof c.output==="string")text=`Résultat : ${c.state??"inconnu"}\n${c.output}`;
      }catch{/* Older events may be plain text. */}
      return `${new Date(e.ts).toISOString()} · Tour ${e.turn ?? 1} · ${e.type}\n${redact(text)}`;
    }).join("\n\n");
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="atelier-task-${task.id}.log"`, "cache-control": "no-store" });
    res.end(`Tâche : ${redact(task.prompt)}\nBranche : ${task.branch ?? "en préparation"}\nÉtat : ${task.status}\n\n${events}`);
    return true;
  }
  if (kind === "automations") {
    gate("project:manage");
    if (!id && req.method === "GET") {
      json(res, 200, listAutomations(org!));
      return true;
    }
    if (!id && req.method === "POST") {
      const a = saveAutomation(org!, user.id, await body(req));
      log("automation.create", a.id);
      json(res, 201, a);
      return true;
    }
    const a = id ? getAutomation(id, org!) : undefined;
    if (!a) throw new HttpError(404, "Agent introuvable.");
    if (!sub && req.method === "PATCH") {
      const updated = saveAutomation(org!, user.id, await body(req), a);
      log("automation.update", a.id);
      json(res, 200, updated);
      return true;
    }
    if (!sub && req.method === "DELETE") {
      db.prepare("delete from automations where id=? and org_id=?").run(
        a.id,
        org!,
      );
      log("automation.delete", a.id);
      json(res, 200, { ok: true });
      return true;
    }
    if (sub === "run" && req.method === "POST") {
      const task = runAutomation(a);
      if (!task)
        throw new HttpError(
          409,
          "L'agent est occupé, son plafond est atteint ou sa configuration demande une intervention.",
        );
      log("automation.trigger", a.id);
      json(res, 201, task);
      return true;
    }
  }
  if (kind === "projects") {
    if (id === "templates" && req.method === "GET") {
      gate("project:manage");
      json(
        res,
        200,
        Object.entries(TEMPLATES).map(([id, t]) => ({ id, label: t.label })),
      );
      return true;
    }
    if (id === "scaffold" && req.method === "POST") {
      gate("project:manage");
      const b = await body(req);
      if (
        b.prompt !== undefined &&
        (typeof b.prompt !== "string" ||
          !b.prompt.trim() ||
          b.prompt.length > 20_000)
      )
        throw new HttpError(400, "Demande invalide.");
      if (b.prompt && overBudget(org!))
        throw new HttpError(402, "Budget mensuel épuisé.");
      const project = await scaffold(org!, b);
      const started = b.prompt
        ? startTask({
            orgId: org!,
            userId: user.id,
            project,
            prompt: b.prompt.trim(),
          })
        : null;
      log("project.scaffold", project.id, { template: b.template });
      json(res, 201, { project: rowToJson(project), ...started });
      return true;
    }
    const project = id ? getProjectInOrg(id, org!) : undefined;
    if (!project) throw new HttpError(404, "Projet introuvable.");
    if (sub === "runtime") {
      gate("project:manage");
      if (req.method === "GET") {
        json(res, 200, {
          runtime: runtimeOf(project),
          appsDomain: appsDomain || null,
          productionUrl: productionUrl(project.id),
        });
        return true;
      }
      if (req.method === "PUT") {
        const runtime = validateRuntime(await body(req));
        updateProject(project.id, org!, {
          runtime_json: JSON.stringify(runtime),
        });
        log("project.runtime", project.id);
        json(res, 200, runtime);
        return true;
      }
    }
    if (sub === "environment") {
      gate("secret:manage");
      if (req.method === "GET") {
        json(
          res,
          200,
          db
            .prepare(
              "select environment,name from project_environment where org_id=? and project_id=? order by environment,name",
            )
            .all(org!, id!),
        );
        return true;
      }
      if (req.method === "PUT") {
        const b = await body(req);
        setEnvironment(org!, id!, b.environment, b.name, b.value);
        log("project.environment", id!, {
          environment: b.environment,
          name: b.name,
          removed: b.value === null,
        });
        json(res, 200, { ok: true });
        return true;
      }
    }
    if (sub === "releases") {
      gate(req.method === "GET" ? "task:read" : "task:create");
      if (req.method === "GET") {
        json(res, 200, listReleases(org!, id!));
        return true;
      }
      if (req.method === "POST") {
        const b = await body(req);
        if (b.taskId !== undefined && typeof b.taskId !== "string")
          throw new HttpError(400, "Tâche invalide.");
        const r = queueRelease(org!, id!, user.id, b.taskId);
        log("release.create", r.id, { projectId: id });
        json(res, 202, releaseJson(r));
        return true;
      }
    }
  }
  if (kind === "releases") {
    gate(
      sub === "publish" || sub === "rollback" ? "project:manage" : "task:read",
    );
    const release = id ? getRelease(id, org!) : undefined;
    if (!release) throw new HttpError(404, "Version introuvable.");
    if (sub === "logs" && req.method === "GET") {
      const redact = await taskLogRedactor(org!);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="atelier-release-${release.id}.log"`, "cache-control": "no-store" });
      res.end(`Projet : ${getProjectInOrg(release.project_id, org!)?.name}\nBranche : ${release.ref}\nCommit : ${release.sha ?? "en préparation"}\nÉtat : ${release.state}\n\n${redact(release.log, 120000)}`);
      return true;
    }
    if (!sub && req.method === "GET") {
      json(res, 200, releaseJson(release, true));
      return true;
    }
    if (sub === "access" && req.method === "POST") {
      json(res, 200, issuePreviewAccess(release, user.id, sessionToken));
      return true;
    }
    if (sub === "publish" && req.method === "POST") {
      const b = await body(req);
      json(
        res,
        200,
        await publishRelease(release, user.id, b.reviewed === true),
      );
      return true;
    }
    if (sub === "rollback" && req.method === "POST") {
      json(
        res,
        200,
        await rollbackRelease(org!, release.project_id, user.id, release.id),
      );
      return true;
    }
    if (
      ["report", "desktop.png", "mobile.png"].includes(sub ?? "") &&
      req.method === "GET"
    ) {
      try {
        const value = await readFile(
          join(
            releaseDir(release.id),
            "qa",
            sub === "report" ? "report.json" : sub!,
          ),
        );
        res.writeHead(200, {
          "content-type": sub === "report" ? "application/json" : "image/png",
          "cache-control": "no-store",
        });
        res.end(value);
      } catch {
        json(res, 404, { error: "Rapport pas encore disponible." });
      }
      return true;
    }
  }
  if (kind === "tasks" && sub === "resume" && req.method === "POST") {
    gate("task:create");
    const task = getTaskInOrg(id!, org!);
    if (!task) throw new HttpError(404, "Tâche introuvable.");
    if (task.user_id !== user.id && !can(role, "task:cancel_any"))
      throw new HttpError(403, "Droits insuffisants.");
    if (
      !task.pushed_sha ||
      task.status !== "failed" ||
      task.turn !== 1
    )
      throw new HttpError(409, "Aucune proposition à reprendre.");
    const project = getProjectInOrg(task.project, org!);
    if (!project) throw new HttpError(404, "Projet introuvable.");
    const mr =
      task.mr_url ?? (await retryProposal(rowToProject(project), task));
    updateTask(task.id, { status: "done", mr_url: mr, last_error: null });
    log("task.resume", task.id);
    json(res, 200, getTaskInOrg(task.id, org!));
    return true;
  }
  throw new HttpError(405, "Méthode non autorisée.");
}
