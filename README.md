# @jennefer-dev/connect

Connect your script or app to **Jennefer's local AI API**: an OpenAI-compatible endpoint that the Jennefer desktop app serves on your computer, using the model you picked in Jennefer.

This package handles the sign-in for you: it asks Jennefer for access with PKCE, shows the short code the user confirms in Jennefer, stores the tokens and refreshes them.

- Zero dependencies. Node 20+ and modern browsers.
- Works with the official OpenAI SDK.
- Includes a small CLI for shell scripts.

> Your app must be **registered and approved** at [portal.jennefer.dev/apps](https://portal.jennefer.dev/apps), and the user must turn on **Settings > Connected apps > Local API** in Jennefer. See the [docs](https://jennefer.dev/docs/connected-apps).

## Install

```bash
npm install @jennefer-dev/connect
```

## Use with the OpenAI SDK

```js
import OpenAI from "openai";
import { connect } from "@jennefer-dev/connect";

// The first time, this prints a code and waits until the user chooses Allow in Jennefer.
// After that, saved tokens are reused and refreshed without asking again.
const jennefer = await connect({ clientId: "jen_app_...", scopes: ["chat"] });

const ai = new OpenAI({ baseURL: jennefer.baseURL, apiKey: "jennefer", fetch: jennefer.fetch });
const reply = await ai.chat.completions.create({
  model: "jennefer", // ignored: Jennefer always uses the user's active model
  messages: [{ role: "user", content: "Hello" }],
});
console.log(reply.choices[0].message.content);
```

`jennefer.fetch` adds a fresh token to every request and retries once after a refresh. If you prefer a plain token, call `await jennefer.token()`.

### In a browser

The same code works in a web app that runs on one of the app's registered origins. Show the code to the user with `onCode`:

```js
const jennefer = await connect({
  clientId: "jen_app_...",
  onCode: (code) => showBanner(`Allow this app in Jennefer. Code: ${code}`),
});
const ai = new OpenAI({ baseURL: jennefer.baseURL, apiKey: "jennefer", fetch: jennefer.fetch, dangerouslyAllowBrowser: true });
```

In browsers, tokens are kept in memory by default. Pass your own `store` (`get`, `set`, `delete`) to keep them longer.

## CLI

```bash
# Once: shows a code, then waits until you choose Allow in Jennefer.
npx @jennefer-dev/connect login jen_app_...

# Any time after that: prints a valid access token (refreshed when needed).
TOKEN=$(npx @jennefer-dev/connect token jen_app_...)
curl http://127.0.0.1:48488/v1/chat/completions \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"model":"jennefer","messages":[{"role":"user","content":"Hello"}]}'

# Forget the saved tokens on this computer.
npx @jennefer-dev/connect logout jen_app_...
```

Options: `--scopes chat,images` for `login`, and `--url <gateway>` if Jennefer runs on another port.

## API

| Export | What it does |
|---|---|
| `connect(options)` | Returns `{ baseURL, token(), fetch, disconnect() }` with a valid token, signing in only when needed. |
| `authorize(options)` | Runs the sign-in once and returns the tokens. |
| `refreshTokens(options, refreshToken)` | Exchanges a refresh token for a new pair. Refresh tokens rotate on every use. |
| `createPkce()` | A PKCE S256 verifier and challenge. |
| `FileTokenStore` (Node) | Tokens in `~/.jennefer-connect/<clientId>.json`, owner-only on macOS and Linux. Default in Node. |
| `MemoryTokenStore` | Tokens in memory. Default in browsers. |
| `JenneferConnectError` | Errors carry a `code`, for example `access_denied`, `app_not_registered`, `origin_not_allowed` or `jennefer_unreachable`. |

`options`: `clientId` (required), `scopes`, `baseUrl` (default `http://127.0.0.1:48488`), `onCode`, `store`, `signal`, `fetch`.

## What apps can do

Text generation (`/v1/chat/completions`, with streaming) and image generation (`/v1/images/generations`) with the user's own model, nothing else: no files, no terminal, no agents. Limits and error codes are in the [docs](https://jennefer.dev/docs/connected-apps).

## License

MIT
