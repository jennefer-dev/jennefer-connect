#!/usr/bin/env node
import { request } from "node:http";
import { authorize, DEFAULT_BASE_URL, FileTokenStore, JenneferConnectError, refreshTokens, type Scope } from "./node.js";

/**
 * fetch over node:http without keep-alive. Global fetch keeps the socket open for a few seconds after the reply,
 * which delays the CLI's exit (and process.exit with an open socket crashes Node 24 on Windows).
 */
const closingFetch: typeof fetch = (input, init) =>
  new Promise((resolve, reject) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = typeof init?.body === "string" ? init.body : undefined;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
    if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
    const req = request(url, { method: init?.method ?? "GET", headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0 })));
      res.on("error", reject);
    });
    req.on("error", reject);
    init?.signal?.addEventListener("abort", () => req.destroy(new Error("Aborted")), { once: true });
    req.end(body);
  });

const HELP = `Connect a script to Jennefer's local AI API.

Usage
  jennefer-connect login <client_id> [--scopes chat,images] [--url <gateway>]
      Ask for access. Shows a code; choose Allow in Jennefer. Tokens are saved
      in ~/.jennefer-connect.
  jennefer-connect token <client_id> [--url <gateway>]
      Print a valid access token (refreshed when needed). For shell scripts:
        TOKEN=$(npx @jennefer-dev/connect token <client_id>)
  jennefer-connect logout <client_id>
      Forget the saved tokens on this computer.

Register your app and get its client id at https://portal.jennefer.dev/apps
Docs: https://jennefer.dev/docs/connected-apps`;

const EARLY_REFRESH_MS = 60_000;

function parse(argv: string[]) {
  const args: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      flags[k] = v ?? argv[++i] ?? "";
    } else args.push(a);
  }
  return { args, flags };
}

async function main(): Promise<number> {
  const { args, flags } = parse(process.argv.slice(2));
  const [command, clientId] = args;
  if (!command || command === "help" || flags.help !== undefined || !clientId) {
    process.stdout.write(`${HELP}\n`);
    return command && command !== "help" ? 1 : 0;
  }
  const store = new FileTokenStore();
  const opts = { clientId, baseUrl: flags.url || DEFAULT_BASE_URL, fetch: closingFetch };

  if (command === "login") {
    const scopes = flags.scopes ? (flags.scopes.split(",").map((s) => s.trim()) as Scope[]) : undefined;
    const tokens = await authorize({ ...opts, scopes, onCode: (code) => process.stderr.write(`\nAllow this app in Jennefer. Check that the code there is ${code}\nWaiting…\n`) });
    await store.set(clientId, tokens);
    process.stderr.write(`Connected (${tokens.scopes.join(", ") || "no scopes"}). Tokens saved in ${store.dir}.\n`);
    return 0;
  }

  if (command === "token") {
    let tokens = await store.get(clientId);
    if (!tokens) {
      process.stderr.write(`Not connected. Run: jennefer-connect login ${clientId}\n`);
      return 1;
    }
    if (tokens.expiresAt - EARLY_REFRESH_MS <= Date.now()) {
      tokens = await refreshTokens(opts, tokens.refreshToken);
      await store.set(clientId, tokens);
    }
    process.stdout.write(`${tokens.accessToken}\n`);
    return 0;
  }

  if (command === "logout") {
    await store.delete(clientId);
    process.stderr.write("Saved tokens removed. To revoke access too, use Jennefer > Settings > Connected apps.\n");
    return 0;
  }

  process.stderr.write(`Unknown command: ${command}\n\n${HELP}\n`);
  return 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    if (error instanceof JenneferConnectError) {
      const hint = error.code === "invalid_grant" || error.code === "consent_required" ? `\nRun: jennefer-connect login ${process.argv[3] ?? "<client_id>"}` : "";
      process.stderr.write(`${error.message} (${error.code})${hint}\n`);
    } else process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
