import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { authorize, connect, createPkce, FileTokenStore, JenneferConnectError, MemoryTokenStore } from "../dist/node.js";

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A small stand-in for Jennefer's gateway (src-tauri/src/apps_gateway.rs): same routes, same error shapes. */
function mockGateway({ approve = true, pendingPolls = 1 } = {}) {
  const requests = new Map();
  const access = new Map();
  const refresh = new Map();
  const log = [];
  const issue = (clientId, scopes) => {
    const at = `jen_at_${b64url(randomBytes(16))}`;
    const rt = `jen_rt_${b64url(randomBytes(16))}`;
    access.set(at, clientId);
    refresh.set(rt, { clientId, scopes });
    return { access_token: at, token_type: "Bearer", expires_in: 3600, refresh_token: rt, scope: scopes.join(" ") };
  };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : {};
    const send = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    log.push(`${req.method} ${req.url}`);
    if (req.url === "/auth/request") {
      if (json.client_id !== "jen_app_test0001") return send(403, { error: { code: "app_not_registered", message: "This app is not registered." } });
      const id = `r${requests.size + 1}`;
      requests.set(id, { challenge: json.code_challenge, polls: 0, scopes: json.scopes ?? ["chat"] });
      return send(200, { request_id: id, user_code: "KQ7-4MZ", expires_in: 300, interval: 0.02 });
    }
    if (req.url === "/auth/token" && json.grant_type === "jennefer_request") {
      const r = requests.get(json.request_id);
      if (!r) return send(400, { error: "invalid_grant", error_description: "Unknown request." });
      if (b64url(createHash("sha256").update(json.code_verifier).digest()) !== r.challenge) return send(400, { error: "invalid_grant", error_description: "PKCE mismatch." });
      if (r.polls++ < pendingPolls) return send(400, { error: "authorization_pending", error_description: "Waiting." });
      requests.delete(json.request_id);
      if (!approve) return send(400, { error: "access_denied", error_description: "The user denied access in Jennefer." });
      return send(200, issue("jen_app_test0001", r.scopes));
    }
    if (req.url === "/auth/token" && json.grant_type === "refresh_token") {
      const entry = refresh.get(json.refresh_token);
      if (!entry) return send(400, { error: "invalid_grant", error_description: "The refresh token is not valid." });
      refresh.delete(json.refresh_token);
      return send(200, issue(entry.clientId, entry.scopes));
    }
    if (req.url === "/v1/models") {
      const token = (req.headers.authorization ?? "").replace("Bearer ", "");
      if (!access.has(token)) return send(401, { error: { code: "invalid_token", message: "The access token is not valid." } });
      return send(200, { object: "list", data: [{ id: "jennefer" }] });
    }
    send(404, { error: { code: "not_found", message: "Not found" } });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({ base, log, access, refresh, close: () => new Promise((r) => server.close(r)) });
    }),
  );
}

test("PKCE pair is S256 over a 43-character verifier", async () => {
  const { verifier, challenge } = await createPkce();
  assert.equal(verifier.length, 43);
  assert.match(verifier + challenge, /^[A-Za-z0-9_-]+$/);
  assert.equal(challenge, b64url(createHash("sha256").update(verifier).digest()));
});

test("authorize waits for Allow, reports the code and returns tokens", async () => {
  const gw = await mockGateway({ pendingPolls: 2 });
  let code = null;
  const tokens = await authorize({ clientId: "jen_app_test0001", baseUrl: gw.base, scopes: ["chat", "images"], onCode: (c) => (code = c) });
  assert.equal(code, "KQ7-4MZ");
  assert.match(tokens.accessToken, /^jen_at_/);
  assert.deepEqual(tokens.scopes, ["chat", "images"]);
  assert.ok(tokens.expiresAt > Date.now() + 3500_000);
  assert.equal(gw.log.filter((l) => l === "POST /auth/token").length, 3);
  await gw.close();
});

test("denied access and unknown apps reject with their code", async () => {
  const gw = await mockGateway({ approve: false });
  await assert.rejects(authorize({ clientId: "jen_app_test0001", baseUrl: gw.base, onCode() {} }), (e) => e instanceof JenneferConnectError && e.code === "access_denied");
  await assert.rejects(authorize({ clientId: "jen_app_nope0001", baseUrl: gw.base, onCode() {} }), (e) => e.code === "app_not_registered" && e.status === 403);
  await gw.close();
});

test("an unreachable gateway gives a clear hint", async () => {
  await assert.rejects(authorize({ clientId: "jen_app_test0001", baseUrl: "http://127.0.0.1:1", onCode() {} }), (e) => e.code === "jennefer_unreachable" && /Local API/.test(e.message));
});

test("connect reuses stored tokens, and fetch refreshes once after a 401", async () => {
  const gw = await mockGateway();
  const store = new MemoryTokenStore();
  let dialogs = 0;
  const opts = { clientId: "jen_app_test0001", baseUrl: gw.base, store, onCode: () => dialogs++ };
  const first = await connect(opts);
  assert.equal(first.baseURL, `${gw.base}/v1`);
  assert.equal(dialogs, 1);

  // Second connect: stored token still valid, no dialog.
  const second = await connect(opts);
  assert.equal(dialogs, 1);
  assert.equal(await second.token(), await first.token());

  // Jennefer forgot the access token (app restart): fetch refreshes and retries.
  gw.access.clear();
  const res = await second.fetch(`${second.baseURL}/models`);
  assert.equal(res.status, 200);
  assert.equal(dialogs, 1, "refresh, not a new dialog");
  assert.notEqual(await second.token(), await first.token());

  // Refresh token revoked too: falls back to a new sign-in.
  gw.access.clear();
  gw.refresh.clear();
  const again = await second.fetch(`${second.baseURL}/models`);
  assert.equal(again.status, 200);
  assert.equal(dialogs, 2);
  await gw.close();
});

test("expired tokens are refreshed before use; parallel calls share one refresh", async () => {
  const gw = await mockGateway();
  const store = new MemoryTokenStore();
  const opts = { clientId: "jen_app_test0001", baseUrl: gw.base, store, onCode() {} };
  const conn = await connect(opts);
  const stored = await store.get("jen_app_test0001");
  await store.set("jen_app_test0001", { ...stored, expiresAt: Date.now() - 1 });
  const conn2 = await connect(opts);
  const tokens = await Promise.all([conn2.token(), conn2.token(), conn2.token()]);
  assert.equal(new Set(tokens).size, 1);
  assert.equal(gw.log.filter((l) => l === "POST /auth/token").length, 3, "1 pending + 1 approve + 1 refresh");
  await conn.disconnect();
  assert.equal(await store.get("jen_app_test0001"), null);
  await gw.close();
});

test("file store keeps tokens per client id, owner-only on POSIX", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jc-"));
  const store = new FileTokenStore(dir);
  const tokens = { accessToken: "jen_at_a", refreshToken: "jen_rt_b", expiresAt: 1, scopes: ["chat"] };
  await store.set("jen_app_test0001", tokens);
  assert.deepEqual(await store.get("jen_app_test0001"), tokens);
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "jen_app_test0001.json")).mode & 0o777, 0o600);
  await assert.rejects(store.set("../evil", tokens), /Invalid client id/);
  await store.delete("jen_app_test0001");
  assert.equal(await store.get("jen_app_test0001"), null);
});

function runCli(args, env) {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("CLI: login, token, logout", async () => {
  const gw = await mockGateway();
  const home = mkdtempSync(join(tmpdir(), "jc-home-"));
  const env = { HOME: home, USERPROFILE: home };
  const login = await runCli(["login", "jen_app_test0001", "--url", gw.base, "--scopes", "chat"], env);
  assert.equal(login.code, 0, login.stderr);
  assert.match(login.stderr, /KQ7-4MZ/);
  const saved = JSON.parse(readFileSync(join(home, ".jennefer-connect", "jen_app_test0001.json"), "utf8"));
  const token = await runCli(["token", "jen_app_test0001", "--url", gw.base], env);
  assert.equal(token.code, 0, token.stderr);
  assert.equal(token.stdout.trim(), saved.accessToken);
  const out = await runCli(["logout", "jen_app_test0001"], env);
  assert.equal(out.code, 0);
  const missing = await runCli(["token", "jen_app_test0001"], env);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Run: jennefer-connect login/);
  const help = await runCli([], env);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /portal\.jennefer\.dev\/apps/);
  await gw.close();
});
