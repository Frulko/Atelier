import { expect, test } from "vitest";
import { auditTone, describeAudit, describeOwn } from "./labels";

test("describeAudit : phrases lisibles, avec les détails du journal", () => {
  expect(describeAudit({ action: "member.role", meta: { email: "a@b.fr", from: "member", to: "admin" } })).toBe("a changé le rôle de a@b.fr : Membre → Administrateur");
  expect(describeAudit({ action: "org.budget_set", meta: { budgetUsdMonth: null } })).toBe("a supprimé le plafond mensuel");
  expect(describeAudit({ action: "org.budget_set", meta: { budgetUsdMonth: 50 } })).toBe("a fixé le plafond mensuel à 50 $");
  expect(describeAudit({ action: "secret.update", meta: { label: "GitLab", rotated: true } })).toBe("a changé la valeur du secret « GitLab »");
  expect(describeAudit({ action: "task.create", meta: { project: "MonRégis" } })).toBe("a lancé une tâche sur « MonRégis »");
});

test("describeAudit : une action inconnue ou des détails absents ne cassent rien", () => {
  expect(describeAudit({ action: "futur.action", meta: null })).toBe("futur.action");
  expect(describeAudit({ action: "project.create", meta: null })).toBe("a créé le projet «  »");
});

test("auditTone : ce qui détruit ressort, ce qui crée est positif", () => {
  expect(auditTone("secret.delete")).toBe("bad");
  expect(auditTone("auth.login_failed")).toBe("bad");
  expect(auditTone("project.create")).toBe("ok");
  expect(auditTone("member.role")).toBe("warn");
  expect(auditTone("task.cancel")).toBe("muted");
});

test("describeOwn : la même phrase à la deuxième personne", () => {
  expect(describeOwn({ action: "task.create", meta: { project: "X" } })).toBe("Tu as lancé une tâche sur « X »");
  expect(describeOwn({ action: "auth.login", meta: null })).toBe("Tu t'es connecté(e)");
  expect(describeOwn({ action: "auth.login_failed", meta: null })).toBe("Tentative de connexion échouée");
  expect(describeOwn({ action: "invitation.accept", meta: { email: "a@b.fr", role: "member" } })).toBe("Tu as rejoint l'organisation (membre)");
});
