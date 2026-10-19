import { readFileSync } from "node:fs";
import {
  insertProject,
  updateProject,
  getProjectInOrg,
  deleteProject,
} from "./db.ts";
import { createManagedRepo } from "./git.ts";
import { validateProject } from "./projects.ts";
import { HttpError } from "./http.ts";

const templateFile = (name: string) =>
  readFileSync(new URL(`../templates/node/${name}`, import.meta.url), "utf8");

export const TEMPLATES = {
  static: {
    label: "Site HTML / CSS",
    check: "node --check public/app.js",
    runtime: {
      build: "",
      output: "public",
      start: "",
      policy: "manual",
      preview: true,
    },
    files: {
      "public/index.html":
        '<!doctype html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mon projet</title><link rel="stylesheet" href="/style.css"></head><body><main><p>Votre projet commence ici</p><h1>Une idée, puis une application.</h1><p>Décrivez ce que vous souhaitez construire dans Atelier.</p></main><script src="/app.js" defer></script></body></html>',
      "public/style.css":
        "body{margin:0;background:#f7f5ef;color:#24221e;font:18px/1.6 system-ui}main{max-width:900px;margin:15vh auto;padding:32px}h1{font-size:clamp(42px,7vw,90px);line-height:1.05;letter-spacing:-.05em}",
      "public/app.js": 'document.documentElement.dataset.ready = "true";\n',
    } as Record<string, string>,
  },
  react: {
    label: "Application React",
    check: "npm run build",
    runtime: {
      build: "npm run build",
      output: "dist",
      start: "",
      policy: "manual",
      preview: true,
    },
    files: {
      "package.json": JSON.stringify(
        {
          name: "atelier-project",
          private: true,
          type: "module",
          scripts: { dev: "vite --host 0.0.0.0", build: "vite build" },
          dependencies: {
            react: "^19.2.0",
            "react-dom": "^19.2.0",
            vite: "^7.1.0",
          },
        },
        null,
        2,
      ),
      "index.html":
        '<!doctype html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mon projet</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>',
      "src/main.jsx":
        'import React from "react";\nimport {createRoot} from "react-dom/client";\nimport "./style.css";\nfunction App(){return <main><p>Votre projet commence ici</p><h1>Une idée, puis une application.</h1><p>Décrivez ce que vous souhaitez construire dans Atelier.</p></main>}\ncreateRoot(document.getElementById("root")).render(<App/>);\n',
      "src/style.css":
        "body{margin:0;background:#f7f5ef;color:#24221e;font:18px/1.6 system-ui}main{max-width:900px;margin:15vh auto;padding:32px}h1{font-size:clamp(42px,7vw,90px);line-height:1.05;letter-spacing:-.05em}",
    } as Record<string, string>,
  },
  node: {
    label: "Application Node.js",
    check: "node --check server.mjs && node --test",
    runtime: {
      build: "",
      output: "public",
      start: "node server.mjs",
      policy: "manual",
      preview: true,
    },
    files: {
      "package.json": JSON.stringify(
        {
          name: "atelier-node",
          private: true,
          type: "module",
          scripts: { start: "node server.mjs", test: "node --test" },
        },
        null,
        2,
      ),
      "server.mjs": templateFile("server.mjs"),
      "server.test.mjs": templateFile("checks.mjs"),
      "lib/auth.ts": readFileSync(
        new URL("./auth.ts", import.meta.url),
        "utf8",
      ),
    } as Record<string, string>,
  },
};

export async function scaffold(orgId: string, input: any) {
  if (!Object.hasOwn(TEMPLATES, input.template))
    throw new HttpError(400, "Modèle de projet inconnu.");
  const template = TEMPLATES[input.template as keyof typeof TEMPLATES];
  const validated = validateProject(
    {
      name: input.name,
      slug: input.slug,
      repo: "https://atelier.invalid/project.git",
      forge: "none",
      check: template.check,
      protectedPaths: [".github/", "migrations/", "db/"],
    },
    false,
  );
  if (!validated.ok) throw new HttpError(400, validated.error);
  const p = validated.value as Required<typeof validated.value>;
  const id = insertProject({
    org_id: orgId,
    slug: p.slug,
    name: p.name,
    repo: p.repo,
    branch: "main",
    forge: "none",
    check_cmd: p.check,
    engine: "claude",
    protected_paths: JSON.stringify(p.protectedPaths),
    git_secret_id: null,
  });
  try {
    await createManagedRepo(id, {
      ...template.files,
      ".gitignore": "node_modules/\ndist/\n.env\n*.sqlite\n",
      "AGENTS.md":
        "Respecte la structure du projet. Les dépendances npm sont installées par Atelier. Ne commets jamais de secret.\n",
    });
    updateProject(id, orgId, {
      managed: 1,
      repo: `https://atelier.invalid/${id}.git`,
      runtime_json: JSON.stringify(template.runtime),
    });
    return getProjectInOrg(id, orgId)!;
  } catch (e) {
    deleteProject(id, orgId);
    throw e;
  }
}
