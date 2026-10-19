import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "./server.mjs";
test("accounts, private data, files, CSRF and persistent SQLite", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-test-")),
    app = await createApplication(root);
  app.listen(0, "127.0.0.1");
  await new Promise((r) => app.once("listening", r));
  const url = `http://127.0.0.1:${app.address().port}`;
  const call = (method, path, body, cookie) =>
    fetch(url + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    assert.equal((await call("GET", "/api/items")).status, 401);
    const a = await call("POST", "/api/auth/register", {
        email: "a@example.com",
        password: "a-good-password",
      }),
      cookie = a.headers.get("set-cookie").split(";")[0];
    assert.equal(a.status, 200);
    const b = await call("POST", "/api/auth/register", {
        email: "b@example.com",
        password: "a-good-password",
      }),
      other = b.headers.get("set-cookie").split(";")[0];
    const item = await (
      await call("POST", "/api/items", { text: "private" }, cookie)
    ).json();
    assert.ok(item.id);
    assert.deepEqual(
      await (await call("GET", "/api/items", null, other)).json(),
      [],
    );
    assert.equal(
      (await call("DELETE", `/api/items/${item.id}`, null, other)).status,
      404,
    );
    assert.equal(
      (
        await fetch(url + "/api/items", {
          method: "POST",
          headers: { cookie, origin: "https://evil.test" },
          body: "{}",
        })
      ).status,
      403,
    );
    const uploaded = await (
      await fetch(url + "/api/files", {
        method: "POST",
        headers: { cookie, "x-file-name": "hello.txt" },
        body: "hello",
      })
    ).json();
    assert.equal(
      await (
        await fetch(url + `/api/files/${uploaded.id}`, { headers: { cookie } })
      ).text(),
      "hello",
    );
    assert.equal(
      (
        await fetch(url + `/api/files/${uploaded.id}`, {
          headers: { cookie: other },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await call("POST", "/api/auth/login", {
          email: "a@example.com",
          password: "wrong-password",
        })
      ).status,
      401,
    );
    await call("POST", "/api/auth/logout", {}, cookie);
    assert.equal((await call("GET", "/api/items", null, cookie)).status, 401);
  } finally {
    app.closeAllConnections();
    await new Promise((r) => app.close(r));
    await rm(root, { recursive: true, force: true });
  }
});
