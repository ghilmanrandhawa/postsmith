# Postsmith

**Ask your AI assistant for a social media post. Get a finished, on-brand post back, right in the chat.**

Postsmith is an app for ChatGPT and Claude, built on the open [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) standard. You link your account once with OAuth. After that, the assistant writes the copy, Postsmith renders the image as a background job, and an interactive card in the conversation shows live progress. You can then preview the post, copy the caption, download the PNG or schedule it. Each post costs one credit, and you buy credits with Stripe.

```
You:        Make a LinkedIn post — we launched same-day delivery in Lahore.
Assistant:  [calls create_post] → card appears: "Designing the visual… ▓▓▓▓░░"
            → preview image + caption · [Download PNG] [Schedule]
```

## What it shows

| Area | Implementation |
|---|---|
| **In-chat app** | MCP server with an MCP Apps UI resource (`ui://postsmith/post.html`): a React widget bundled into a single HTML file. It renders inline in ChatGPT and Claude. |
| **Long-running jobs** | `create_post` returns right away. Generation runs in the background and the widget polls `get_post` (an app-callable tool) for progress. When the post is done, the widget tells the model so it can suggest next steps. Jobs interrupted by a restart are marked failed and refunded. |
| **Account linking** | A small OAuth 2.1 authorization server written from scratch. It supports Dynamic Client Registration (RFC 7591), the Authorization Code flow with **PKCE (S256 only)**, Resource Indicators (RFC 8707), `iss` in the redirect (RFC 9207), refresh-token rotation with reuse detection, and revocation (RFC 7009). It publishes discovery metadata (RFC 8414 and RFC 9728) so clients can find it from the `401` on `/mcp`. |
| **Secure data handling** | Tokens, codes and sessions are stored only as SHA-256 hashes. Passwords use scrypt. The consent form has a CSRF token bound to the request. Post-login redirects are checked to block open redirects. Download links are HMAC-signed and expire. Tools only ever see the signed-in user's data. |
| **Paid credits** | Stripe Checkout in test mode. Credits are granted from the `checkout.session.completed` webhook (signature checked). A ledger with a unique key per payment means webhook retries can't add credits twice. Credits are spent with an atomic SQL update, and a failed job refunds its credit. |
| **Helpful errors in chat** | Running out of credits returns a message with a top-up link, and the widget shows a Top up button. A caption that's too long for the platform (for example, X's 280 characters) is rejected before any credit is charged, with the exact number of characters to cut. |
| **Works without UI too** | Every tool result includes a text version written for the model. Clients that don't render widgets, or that use the API (Grok), still get the full flow. |

## Tools

| Tool | Who can call it | Purpose |
|---|---|---|
| `create_post` | model | Starts generation from a brief, headline, caption, hashtags, platform and theme. Costs 1 credit. |
| `get_post` | model + widget | Returns status, progress, preview, caption and a signed download link. |
| `schedule_post` | model + widget | Schedules a finished post. |
| `list_posts` | model | Lists recent posts. |
| `get_account` | model | Returns the credit balance and the top-up link. |

The assistant writes the copy itself, so no API key for a language model is needed. In a real product, `src/posts.ts` is where the existing content backend would plug in: image generation, brand checks and publishing APIs. Here those steps are simulated with delays, and the image is rendered locally from SVG with `sharp`.

## Run it locally

```bash
npm install
cp .env.example .env
npm run dev            # http://localhost:3000, MCP endpoint at /mcp
npm test               # end-to-end: sign-up → OAuth/PKCE → tools → download → billing → token rotation
```

To see the widget without ChatGPT or Claude, run the local host harness. It plays the role of the chat client: a sandboxed iframe connected through the MCP Apps bridge.

```bash
npm run token          # runs the OAuth flow and prints an access token
npm run harness        # open http://localhost:5174/?token=<token>   (&theme=dark &platform=x …)
```

## Connect it to ChatGPT or Claude

Both need a public HTTPS URL. Set `BASE_URL` to it, because it becomes the OAuth issuer and the token audience.

```bash
ngrok http 3000                       # then set BASE_URL=https://<id>.ngrok.app in .env and restart
```

- **ChatGPT:** Settings → Apps → Advanced settings → turn on Developer mode → Create app. Enter `https://<host>/mcp` and choose OAuth as the authentication method.
- **Claude:** Settings → Connectors → Add custom connector → enter `https://<host>/mcp`.
- **Grok:** use xAI's API with a remote MCP tool pointed at `https://<host>/mcp`, and pass a bearer token from `npm run token`.

All three go through the same OAuth flow: register the client, sign up or log in, approve on the consent screen, receive tokens.

## Stripe (test mode)

Without Stripe keys, the account page offers free "dev mode" top-ups so the demo runs offline. To use Stripe:

```bash
STRIPE_SECRET_KEY=sk_test_...         # in .env
stripe listen --forward-to localhost:3000/billing/webhook   # prints STRIPE_WEBHOOK_SECRET=whsec_...
```

Pay with the test card `4242 4242 4242 4242`. The success page also checks the payment with Stripe directly, so credits arrive even if the webhook isn't set up yet.

## Deploy

```bash
docker build -t postsmith .
docker run -p 3000:3000 -v postsmith-data:/data -e BASE_URL=https://your.domain -e APP_SECRET=$(openssl rand -hex 32) postsmith
```

SQLite is stored on the `/data` volume.

## Layout

```
src/
  app.ts            Express app: OAuth metadata, auth server, web pages, billing, /mcp behind bearer auth
  auth/oauth.ts     OAuth 2.1 authorization server (DCR, PKCE, rotation, revocation) + token verifier
  mcp.ts            MCP server: tools + the UI resource
  posts.ts          Background generation jobs, refunds, signed downloads, scheduling
  render.ts         SVG/PNG post renderer per platform
  billing.ts        Stripe Checkout + webhook, dev top-up fallback
  users.ts          Accounts and the credit ledger
  web/              Sign-up, login, consent and account pages
widget/main.tsx     The in-chat card (React, MCP Apps SDK)
harness/            Local stand-in for a chat client, used to test the widget
test/e2e.test.ts    End-to-end test of the whole flow
```

## Stack

TypeScript · Node.js · Express · MCP TypeScript SDK v2 · MCP Apps (`@modelcontextprotocol/ext-apps`) · React · Vite · SQLite · Stripe · Docker

Built by Muhammad Ghilman Randhawa with Claude Code as a coding agent. I designed it and reviewed every line.
