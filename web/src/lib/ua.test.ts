import { expect, test } from "vitest";
import { describeAgent } from "./ua";

test("describeAgent reconnaît les navigateurs et systèmes courants", () => {
  expect(describeAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")).toBe("Chrome · macOS");
  expect(describeAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Edg/126.0")).toBe("Edge · Windows");
  expect(describeAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1")).toBe("Safari · iOS");
  expect(describeAgent("Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0")).toBe("Firefox · Linux");
  expect(describeAgent("curl/8.7.1")).toBe("curl");
});

test("describeAgent : valeur absente ou inconnue", () => {
  expect(describeAgent(null)).toBe("Appareil inconnu");
  expect(describeAgent("TotallyCustomAgent/1.0")).toBe("TotallyCustomAgent/1.0");
});
