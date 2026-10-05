import { expect, test } from "vitest";
import { dayLabel, dayRange, fmtDuration, fmtPct, fmtUsd, initials, parseFiles, relTime } from "./format";

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

test("relTime : de l'instant à la date", () => {
  expect(relTime(NOW - 10_000, NOW)).toBe("à l'instant");
  expect(relTime(NOW - 5 * 60_000, NOW)).toBe("il y a 5 min");
  expect(relTime(NOW - 3 * 3_600_000, NOW)).toBe("il y a 3 h");
  expect(relTime(NOW - 30 * 3_600_000, NOW)).toBe("hier");
  expect(relTime(NOW - 4 * 86_400_000, NOW)).toBe("il y a 4 j");
  expect(relTime(NOW + 2 * 86_400_000, NOW)).toBe("dans 2 j");
  expect(relTime(NOW - 90 * 86_400_000, NOW)).toMatch(/2026/);
});

test("fmtDuration : secondes, minutes, heures, et valeurs absentes", () => {
  expect(fmtDuration(45_000)).toBe("45 s");
  expect(fmtDuration(72_000)).toBe("1 min 12 s");
  expect(fmtDuration(3_900_000)).toBe("1 h 05");
  expect(fmtDuration(null)).toBe("—");
  expect(fmtDuration(-5)).toBe("—");
});

test("montants et pourcentages", () => {
  expect(fmtUsd(3.85)).toBe("3,85 $");
  expect(fmtUsd(0)).toBe("0,00 $");
  expect(fmtUsd(null)).toBe("—");
  expect(fmtPct(0.75)).toBe("75 %");
  expect(fmtPct(null)).toBe("—");
});

test("dayLabel lit un jour UTC sans le décaler selon le fuseau", () => {
  expect(dayLabel("2026-10-05")).toMatch(/5/);
  expect(dayLabel("2026-01-01")).toMatch(/1/);
});

test("initials : prénom.nom, e-mail simple, valeurs absentes", () => {
  expect(initials("marie.curie@lab.fr")).toBe("MC");
  expect(initials("admin@localhost")).toBe("A");
  expect(initials("Jean-Luc Picard")).toBe("JP");
  expect(initials(null)).toBe("?");
});

test("parseFiles ignore un JSON invalide ou d'un mauvais type", () => {
  expect(parseFiles('["a.js","b/c.sql"]')).toEqual(["a.js", "b/c.sql"]);
  expect(parseFiles("pas du json")).toEqual([]);
  expect(parseFiles('{"a":1}')).toEqual([]);
  expect(parseFiles(null)).toEqual([]);
});

test("dayRange : le jour de fin est inclus ; une date invalide est ignorée", () => {
  const r = dayRange("2026-10-01", "2026-10-03");
  expect(r.from).toBe(Date.UTC(2026, 9, 1));
  expect(r.to).toBe(Date.UTC(2026, 9, 4));
  expect(dayRange("n'importe quoi", undefined)).toEqual({ from: undefined, to: undefined });
});
