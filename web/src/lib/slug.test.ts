import { expect, test } from "vitest";
import { slugify } from "./slug";

test("slugify : accents, espaces, ponctuation, bornes", () => {
  expect(slugify("Mon Régie — v2")).toBe("mon-regie-v2");
  expect(slugify("  Boulangerie du Coin (site) ")).toBe("boulangerie-du-coin-site");
  expect(slugify("Ça va très bien !")).toBe("ca-va-tres-bien");
  expect(slugify("---")).toBe("");
  expect(slugify("a".repeat(60))).toHaveLength(40);
  expect(slugify("x".repeat(39) + " y")).toBe("x".repeat(39)); // pas de tiret final après la coupe
});
