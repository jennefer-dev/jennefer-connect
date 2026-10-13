// Browser-safe core. Node adds a file token store in ./node.ts.

export const DEFAULT_BASE_URL = "http://127.0.0.1:48488";

export type Scope = "chat" | "images";

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Unix milliseconds. */
  expiresAt: number;
  scopes: Scope[];
}

/** Where tokens are kept between runs. Node uses a file per client id; browsers keep them in memory. */
export interface TokenStore {
  get(clientId: string): Promise<Tokens | null>;
  set(clientId: string, tokens: Tokens): Promise<void>;
  delete(clientId: string): Promise<void>;
}

export interface ConnectOptions {
  /** The client id from your app page at portal.jennefer.dev/apps (jen_app_...). */
  clientId: string;
  /** What to ask for. Defaults to everything the app is registered for. */
  scopes?: Scope[];
  /** The Jennefer local API. Defaults to http://127.0.0.1:48488. */
  baseUrl?: string;
  /** Called with the short code the user must match in Jennefer's permission dialog. */
  onCode?: (code: string) => void;
  store?: TokenStore;
  signal?: AbortSignal;
  /** Custom fetch (tests, proxies). */
  fetch?: typeof fetch;
}

export interface Connection {
  /** OpenAI-compatible base URL, e.g. for `new OpenAI({ baseURL })`. */
  baseURL: string;
  /** A valid access token, refreshed when needed. */
  token(): Promise<string>;
  /** fetch that adds the token and retries once after a refresh. Pass it to the OpenAI SDK's `fetch` option. */
  fetch: typeof fetch;
  /** Forget the stored tokens on this machine. Access can be revoked in Jennefer > Settings > Connected apps. */
  disconnect(): Promise<void>;
}

/** An error from the Jennefer local API, with its code (`access_denied`, `app_not_registered`, ...). */
export class JenneferConnectError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JenneferConnectError";
  }
}

export class MemoryTokenStore implements TokenStore {
  private readonly tokens = new Map<string, Tokens>();
  async get(clientId: string) {
    return this.tokens.get(clientId) ?? null;
  }
  async set(clientId: string, tokens: Tokens) {
    this.tokens.set(clientId, tokens);
  }
  async delete(clientId: string) {
    this.tokens.delete(clientId);
  }
}

/** Renew a little before expiry so a request never starts with a token that dies on the way. */
const EARLY_REFRESH_MS = 60_000;

const base64url = (bytes: ArrayBuffer | Uint8Array) => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = "";
  for (const b of view) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** PKCE S256: a random 43-character verifier and its SHA-256 challenge. */
export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

const trimBase = (url: string) => url.replace(/\/+$/, "");

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Aborted"));
    const id = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        reject(signal.reason ?? new Error("Aborted"));
      },
      { once: true },
    );
  });
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: "invalid_response", error_description: text.slice(0, 200) };
  }
}

/** Both error shapes: OAuth `{ error, error_description }` and OpenAI `{ error: { code, message } }`. */
function toError(body: any, status: number): JenneferConnectError {
  if (body?.error && typeof body.error === "object") return new JenneferConnectError(body.error.code ?? "error", body.error.message ?? `HTTP ${status}`, status);
  return new JenneferConnectError(body?.error ?? "error", body?.error_description ?? `HTTP ${status}`, status);
}

function unreachable(baseUrl: string, cause: unknown): JenneferConnectError {
  const error = new JenneferConnectError(
    "jennefer_unreachable",
    `Could not reach Jennefer at ${baseUrl}. Open the Jennefer desktop app and turn on Settings > Connected apps > Local API.`,
  );
  (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

function toTokens(body: any): Tokens {
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000,
    scopes: String(body.scope ?? "")
      .split(" ")
      .filter(Boolean) as Scope[],
  };
}

async function post(opts: ConnectOptions, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const base = trimBase(opts.baseUrl ?? DEFAULT_BASE_URL);
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: opts.signal });
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    throw unreachable(base, error);
  }
  return { status: res.status, body: await readJson(res) };
}

const defaultOnCode = (code: string) => {
  console.info(`[jennefer] Allow this app in Jennefer. The code is ${code}.`);
};

/**
 * Full sign-in: asks Jennefer for access, reports the code, and waits until the user chooses Allow.
 * Rejects with `access_denied` or `expired_token` when the user denies or does not answer in time.
 */
export async function authorize(opts: ConnectOptions): Promise<Tokens> {
  const { verifier, challenge } = await createPkce();
  const req = await post(opts, "/auth/request", {
    client_id: opts.clientId,
    ...(opts.scopes ? { scopes: opts.scopes } : {}),
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (req.status !== 200) throw toError(req.body, req.status);
  (opts.onCode ?? defaultOnCode)(req.body.user_code);

  let interval = Number(req.body.interval ?? 2) * 1000;
  const deadline = Date.now() + Number(req.body.expires_in ?? 300) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval, opts.signal);
    const res = await post(opts, "/auth/token", { grant_type: "jennefer_request", request_id: req.body.request_id, code_verifier: verifier });
    if (res.status === 200) return toTokens(res.body);
    const code = res.body?.error;
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      interval += 1000;
      continue;
    }
    throw toError(res.body, res.status);
  }
  throw new JenneferConnectError("expired_token", "Nobody allowed the app in Jennefer in time. Try again.");
}

/** New token pair from a refresh token. The old refresh token stops working. */
export async function refreshTokens(opts: ConnectOptions, refreshToken: string): Promise<Tokens> {
  const res = await post(opts, "/auth/token", { grant_type: "refresh_token", client_id: opts.clientId, refresh_token: refreshToken });
  if (res.status !== 200) throw toError(res.body, res.status);
  return toTokens(res.body);
}

/** Errors after which only a new sign-in helps. */
const NEEDS_SIGN_IN = new Set(["invalid_grant", "consent_required", "invalid_token"]);

/**
 * Returns a connection with a valid token. Uses stored tokens when they still work, refreshes them when they
 * expired, and runs the sign-in (with the permission dialog in Jennefer) only when there is no other way.
 */
export async function connect(opts: ConnectOptions): Promise<Connection> {
  const store = opts.store ?? new MemoryTokenStore();
  const base = trimBase(opts.baseUrl ?? DEFAULT_BASE_URL);
  let current = await store.get(opts.clientId);
  let pending: Promise<Tokens> | null = null;

  const refreshOrSignIn = async (): Promise<Tokens> => {
    if (current?.refreshToken) {
      try {
        current = await refreshTokens(opts, current.refreshToken);
        await store.set(opts.clientId, current);
        return current;
      } catch (error) {
        if (!(error instanceof JenneferConnectError) || !NEEDS_SIGN_IN.has(error.code)) throw error;
      }
    }
    current = await authorize(opts);
    await store.set(opts.clientId, current);
    return current;
  };

  /**
   * A valid token pair. One renewal runs at a time: refresh tokens rotate, so two parallel refreshes would make
   * the second one fail. `rejected` is a token the server just refused; it is renewed even if it looks fresh,
   * unless another call already replaced it.
   */
  const renew = async (rejected?: string): Promise<Tokens> => {
    while (pending) await pending.catch(() => undefined);
    if (current && current.accessToken !== rejected && current.expiresAt - EARLY_REFRESH_MS > Date.now()) return current;
    pending = refreshOrSignIn().finally(() => {
      pending = null;
    });
    return pending;
  };

  await renew();

  const token = async () => (await renew()).accessToken;
  const doFetch = opts.fetch ?? fetch;
  const authedFetch: typeof fetch = async (input, init) => {
    const send = async (accessToken: string) => {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set("authorization", `Bearer ${accessToken}`);
      return doFetch(input instanceof Request ? input.clone() : input, { ...init, headers });
    };
    const used = await token();
    const first = await send(used);
    if (first.status !== 401) return first;
    // Expired or forgotten on the Jennefer side: refresh (or sign in again) once.
    return send((await renew(used)).accessToken);
  };

  return {
    baseURL: `${base}/v1`,
    token,
    fetch: authedFetch,
    disconnect: async () => {
      current = null;
      await store.delete(opts.clientId);
    },
  };
}
