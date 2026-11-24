/**
 * Gets an access token for a local or deployed Postsmith by running the same
 * OAuth 2.1 + PKCE flow ChatGPT/Claude use (DCR → authorize → consent → token).
 * Useful for MCP Inspector, the local widget harness, or calling the server from
 * an API (e.g. Grok's remote MCP tools).
 *
 *   npx tsx scripts/dev-token.ts [baseUrl] [email] [password]
 */
import { pkceChallenge, randomToken } from "../src/crypto.js";

const base = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");
const email = process.argv[3] ?? "demo@postsmith.dev";
const password = process.argv[4] ?? "demo-password";
const redirect = "http://localhost:8976/callback"; // never actually opened

let cookie = "";
async function req(path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, { ...init, redirect: "manual", headers: { ...(init.headers as object), cookie } });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return res;
}
const form = (path: string, body: Record<string, string>) =>
  req(path, { method: "POST", body: new URLSearchParams(body), headers: { "content-type": "application/x-www-form-urlencoded" } });

// Log in, or create the account on first run.
let res = await form("/login", { email, password, next: "/account" });
if (res.status !== 303) res = await form("/signup", { email, password, next: "/account" });
if (res.status !== 303) throw new Error(`Could not sign in as ${email}`);

const reg = await (await fetch(`${base}/oauth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "Postsmith dev token script", redirect_uris: [redirect] }),
})).json();

const verifier = randomToken(48);
const params = new URLSearchParams({
  response_type: "code", client_id: reg.client_id, redirect_uri: redirect,
  code_challenge: pkceChallenge(verifier), code_challenge_method: "S256", state: "dev", resource: `${base}/mcp`,
});
const html = await (await req(`/oauth/authorize?${params}`)).text();
const hidden = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2].replace(/&amp;/g, "&")]));
const approved = await form("/oauth/authorize", { ...hidden, decision: "approve" });
const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;

const tokens = await (await fetch(`${base}/oauth/token`, {
  method: "POST",
  body: new URLSearchParams({ grant_type: "authorization_code", client_id: reg.client_id, code, redirect_uri: redirect, code_verifier: verifier }),
})).json();
console.log(tokens.access_token);
