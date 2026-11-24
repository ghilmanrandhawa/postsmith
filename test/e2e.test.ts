/**
 * End-to-end: a user signs up, an MCP client registers + links the account with
 * OAuth 2.1 / PKCE (the way ChatGPT and Claude do), then uses the MCP tools to
 * generate, download and schedule a post, and runs out of credits.
 */
import "./env.js";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "../src/app.js";
import { pkceChallenge, randomToken } from "../src/crypto.js";

const BASE = "http://localhost:3999";
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
let server: Server;

before(async () => {
  server = createApp().listen(3999);
  await new Promise((r) => server.once("listening", r));
});
after(() => server.close());

/** Minimal cookie-jar browser for the sign-up + consent pages. */
class Browser {
  cookie = "";
  async req(path: string, init: RequestInit = {}) {
    const res = await fetch(path.startsWith("http") ? path : BASE + path, {
      ...init,
      redirect: "manual",
      headers: { ...(init.headers as Record<string, string>), cookie: this.cookie },
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0];
    return res;
  }
  post(path: string, form: Record<string, string>) {
    return this.req(path, {
      method: "POST",
      body: new URLSearchParams(form),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
  }
}

async function linkAccount(browser: Browser) {
  // 1. Dynamic client registration
  const reg = await fetch(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
  });
  assert.equal(reg.status, 201);
  const { client_id } = await reg.json();

  // 2. Authorization request with PKCE
  const verifier = randomToken(48);
  const state = randomToken(8);
  const params = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
    state,
    scope: "posts:write posts:read",
    resource: `${BASE}/mcp`,
  });
  const consent = await browser.req(`/oauth/authorize?${params}`);
  assert.equal(consent.status, 200, "signed-in user should see the consent page");
  const html = await consent.text();
  assert.match(html, /Connect ChatGPT to Postsmith/);
  const hidden = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2].replace(/&amp;/g, "&")]));

  // 3. Approve → redirected back with code + state + iss
  const approved = await browser.post("/oauth/authorize", { ...hidden, decision: "approve" });
  assert.equal(approved.status, 303);
  const back = new URL(approved.headers.get("location")!);
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get("state"), state);
  assert.equal(back.searchParams.get("iss"), BASE);
  const code = back.searchParams.get("code")!;

  // 4. Wrong verifier fails, and burns the code
  const tokenReq = (body: Record<string, string>) =>
    fetch(`${BASE}/oauth/token`, { method: "POST", body: new URLSearchParams(body) });
  const bad = await tokenReq({ grant_type: "authorization_code", client_id, code, redirect_uri: REDIRECT, code_verifier: randomToken(48) });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "invalid_grant");

  return { client_id, tokenReq, state, verifier, params };
}

describe("Postsmith end to end", () => {
  const browser = new Browser();
  let accessToken = "";
  let refreshToken = "";
  let clientId = "";

  it("serves OAuth + protected resource metadata", async () => {
    const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
    assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
    const pr = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(pr.resource, `${BASE}/mcp`);
    assert.ok(pr.authorization_servers[0].startsWith(BASE));
  });

  it("rejects /mcp without a token and points to the metadata", async () => {
    const res = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata="http:\/\/localhost:3999\/\.well-known\/oauth-protected-resource\/mcp"/);
  });

  it("sends signed-out users to sign up, then back to consent", async () => {
    const res = await browser.req(`/oauth/authorize?client_id=x`);
    assert.equal(res.status, 400); // unknown client is shown on our page, never redirected
    const signup = await browser.post("/signup", { email: "Demo@Example.com", password: "correct horse", next: "/account" });
    assert.equal(signup.status, 303);
    const account = await (await browser.req("/account")).text();
    assert.match(account, /demo@example\.com/);
    assert.match(account, /<div class="big">3<\/div>/); // 3 signup credits
  });

  it("links the account with OAuth 2.1 + PKCE", async () => {
    const { client_id, tokenReq, verifier, params } = await linkAccount(browser);
    clientId = client_id;
    // linkAccount burned its code with a wrong verifier; get a fresh code and use the right one.
    const html = await (await browser.req(`/oauth/authorize?${params}`)).text();
    const hidden = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2].replace(/&amp;/g, "&")]));
    const approved = await browser.post("/oauth/authorize", { ...hidden, decision: "approve" });
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
    const ok = await tokenReq({ grant_type: "authorization_code", client_id, code, redirect_uri: REDIRECT, code_verifier: verifier, resource: `${BASE}/mcp` });
    assert.equal(ok.status, 200);
    const tokens = await ok.json();
    assert.equal(tokens.token_type, "Bearer");
    accessToken = tokens.access_token;
    refreshToken = tokens.refresh_token;
    // Codes are single-use
    const replay = await tokenReq({ grant_type: "authorization_code", client_id, code, redirect_uri: REDIRECT, code_verifier: verifier });
    assert.equal(replay.status, 400);
  });

  async function mcpClient(token: string) {
    const client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    return client;
  }

  it("lists tools and the widget resource", async () => {
    const client = await mcpClient(accessToken);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["create_post", "get_account", "get_post", "list_posts", "schedule_post"]);
    const create = tools.find((t) => t.name === "create_post")!;
    assert.equal((create._meta as any)?.ui?.resourceUri, "ui://postsmith/post.html");
    const res = await client.readResource({ uri: "ui://postsmith/post.html" });
    const content = res.contents[0] as { mimeType?: string; text?: string };
    assert.equal(content.mimeType, "text/html;profile=mcp-app");
    assert.match(content.text ?? "", /<div id="root">/);
    await client.close();
  });

  it("generates, downloads and schedules a post", async () => {
    const client = await mcpClient(accessToken);
    const created = await client.callTool({
      name: "create_post",
      arguments: {
        platform: "linkedin",
        brief: "We just launched same-day delivery in Lahore",
        headline: "Same-day delivery is here",
        caption: "Order before 2pm, get it tonight.",
        hashtags: ["Lahore", "delivery"],
        theme: "sunset",
      },
    });
    assert.ok(!created.isError, JSON.stringify(created.content));
    const { post, account } = created.structuredContent as any;
    assert.equal(account.credits, 2);
    assert.ok(["queued", "generating"].includes(post.status));

    let current = post;
    for (let i = 0; i < 50 && current.status !== "ready"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      current = ((await client.callTool({ name: "get_post", arguments: { id: post.id } })).structuredContent as any).post;
    }
    assert.equal(current.status, "ready");
    assert.match(current.previewSvg, /^<svg/);
    assert.match(current.fullCaption, /#Lahore #delivery/);

    const png = await fetch(current.downloadUrl);
    assert.equal(png.status, 200);
    assert.equal(png.headers.get("content-type"), "image/png");
    const bytes = Buffer.from(await png.arrayBuffer());
    assert.equal(bytes.subarray(1, 4).toString(), "PNG");
    const tampered = await fetch(current.downloadUrl.replace(/sig=[^&]+/, "sig=nope"));
    assert.equal(tampered.status, 404);

    const past = await client.callTool({ name: "schedule_post", arguments: { id: post.id, publish_at: "2020-01-01T00:00:00Z" } });
    assert.ok(past.isError);
    const when = new Date(Date.now() + 86400_000).toISOString();
    const scheduled = await client.callTool({ name: "schedule_post", arguments: { id: post.id, publish_at: when } });
    assert.equal((scheduled.structuredContent as any).post.status, "scheduled");
    await client.close();
  });

  it("rejects an X caption over 280 characters without charging", async () => {
    const client = await mcpClient(accessToken);
    const res = await client.callTool({
      name: "create_post",
      arguments: { platform: "x", brief: "Long post test", headline: "Too long", caption: "a ".repeat(200), hashtags: [] },
    });
    assert.ok(res.isError);
    assert.match((res.content as any)[0].text, /X allows 280/);
    const acct = await client.callTool({ name: "get_account", arguments: {} });
    assert.equal((acct.structuredContent as any).credits, 2);
    await client.close();
  });

  it("explains how to top up when credits run out", async () => {
    const client = await mcpClient(accessToken);
    const args = { platform: "instagram", brief: "Credits test post", headline: "Hello", caption: "Hi", hashtags: [] };
    await client.callTool({ name: "create_post", arguments: args });
    await client.callTool({ name: "create_post", arguments: args });
    const broke = await client.callTool({ name: "create_post", arguments: args });
    assert.ok(broke.isError);
    assert.equal((broke.structuredContent as any).reason, "insufficient_credits");
    assert.match((broke.content as any)[0].text, /\/account#credits/);

    // Dev-mode top-up from the account page, then it works again.
    const topup = await browser.post("/billing/checkout", { pack: "pack_10" });
    assert.equal(topup.status, 303);
    const again = await client.callTool({ name: "create_post", arguments: args });
    assert.ok(!again.isError);
    assert.equal((again.structuredContent as any).account.credits, 9);
    await client.close();
  });

  it("rotates refresh tokens and revokes the grant on reuse", async () => {
    const refresh = (token: string) =>
      fetch(`${BASE}/oauth/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: token }) });
    const first = await refresh(refreshToken);
    assert.equal(first.status, 200);
    const rotated = await first.json();
    // The old access token stopped working after rotation; the new one works.
    assert.equal((await fetch(`${BASE}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } })).status, 401);
    const client = await mcpClient(rotated.access_token);
    await client.listTools();
    await client.close();
    // Replaying the old refresh token kills the whole grant, including the new tokens.
    assert.equal((await refresh(refreshToken)).status, 400);
    assert.equal((await refresh(rotated.refresh_token)).status, 400);
  });
});
