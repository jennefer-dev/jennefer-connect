// Node entry: same API as the browser build, with tokens kept in a file per client id.
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect as connectCore, type Connection, type ConnectOptions, type TokenStore, type Tokens } from "./index.js";

export * from "./index.js";

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Tokens in `~/.jennefer-connect/<clientId>.json`, readable only by the current user where the OS supports it.
 * Refresh tokens rotate on every use, so the file is rewritten after each refresh.
 */
export class FileTokenStore implements TokenStore {
  constructor(readonly dir: string = join(homedir(), ".jennefer-connect")) {}

  private file(clientId: string) {
    if (!SAFE_ID.test(clientId)) throw new Error(`Invalid client id: ${clientId}`);
    return join(this.dir, `${clientId}.json`);
  }

  async get(clientId: string): Promise<Tokens | null> {
    try {
      const parsed = JSON.parse(await readFile(this.file(clientId), "utf8"));
      return typeof parsed?.accessToken === "string" && typeof parsed?.refreshToken === "string" ? (parsed as Tokens) : null;
    } catch {
      return null;
    }
  }

  async set(clientId: string, tokens: Tokens): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const target = this.file(clientId);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    await rename(tmp, target);
    await chmod(target, 0o600).catch(() => undefined);
  }

  async delete(clientId: string): Promise<void> {
    await rm(this.file(clientId), { force: true });
  }
}

const printCode = (code: string) => {
  process.stderr.write(`\nAllow this app in Jennefer. Check that the code there is ${code}\n\n`);
};

/** Same as the browser `connect`, but remembers tokens on disk and prints the code to stderr by default. */
export function connect(opts: ConnectOptions): Promise<Connection> {
  return connectCore({ store: new FileTokenStore(), onCode: printCode, ...opts });
}
