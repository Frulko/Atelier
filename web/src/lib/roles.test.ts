import { expect, test } from "vitest";
import { atLeast, canAssign, canTouch, ROLES } from "./roles";

test("on n'attribue qu'un rôle inférieur ou égal au sien, et seuls les administrateurs attribuent", () => {
  expect(canAssign("owner", "owner")).toBe(true);
  expect(canAssign("admin", "admin")).toBe(true);
  expect(canAssign("admin", "owner")).toBe(false);
  expect(canAssign("member", "viewer")).toBe(false);
  expect(ROLES.filter((r) => canAssign("admin", r))).toEqual(["viewer", "member", "admin"]);
});

test("seul un propriétaire touche à un propriétaire", () => {
  expect(canTouch("owner", "owner")).toBe(true);
  expect(canTouch("admin", "owner")).toBe(false);
  expect(canTouch("admin", "member")).toBe(true);
  expect(canTouch("member", "viewer")).toBe(false);
});

test("atLeast gère un rôle inconnu", () => {
  expect(atLeast(undefined, "viewer")).toBe(false);
  expect(atLeast("member", "member")).toBe(true);
  expect(atLeast("viewer", "member")).toBe(false);
});
