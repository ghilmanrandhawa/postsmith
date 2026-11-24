/**
 * A small OAuth 2.1 authorization server, built for MCP clients (ChatGPT, Claude, …):
 *
 *  - Dynamic Client Registration (RFC 7591) — clients register themselves, public clients only
 *  - Authorization Code + PKCE (S256 only, required) — RFC 7636 / OAuth 2.1
 *  - Resource Indicators (RFC 8707) — tokens are bound to this server's /mcp URL
 *  - Refresh token rotation with reuse detection — a replayed refresh token revokes the whole grant
 *  - Token revocation (RFC 7009)
 *
 * Authorization server metadata (RFC 8414) and protected resource metadata (RFC 9728) are
 * served by the MCP SDK's `mcpAuthMetadataRouter` in index.ts using `oauthMetadata` below.
 */
import express, { type Request, type Response, Router } from "express";
import { type AuthInfo, OAuthError, type OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { config } from "../config.js";
import { newId, pkceChallenge, randomToken, safeEqual, sha256, sign } from "../crypto.js";
import { db, now } from "../db.js";
import { getUser } from "../users.js";
import { consentPage, errorPage } from "../web/pages.js";
import { currentUser } from "../web/session.js";

export const oauthMetadata = {
  issuer: config.baseUrl,
  authorization_endpoint: `${config.baseUrl}/oauth/authorize`,
  token_endpoint: `${config.baseUrl}/oauth/token`,
  registration_endpoint: `${config.baseUrl}/oauth/register`,
  revocation_endpoint: `${config.baseUrl}/oauth/revoke`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  revocation_endpoint_auth_methods_supported: ["none"],
  scopes_supported: [...config.scopes],
};

interface Client {
  client_id: string;
  client_name: string | null;
  redirect_uris: string;
}

const getClient = (id: unknown) =>
  typeof id === "string"
    ? (db.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").get(id) as Client | undefined)
    : undefined;

const redirectUris = (c: Client) => JSON.parse(c.redirect_uris) as string[];

function isAllowedRedirect(uri: string) {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    // Loopback redirects for local tools (MCP Inspector, CLIs).
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Tokens must be requested for this server; missing `resource` defaults to it. */
function normalizeResource(resource: unknown): string | null {
  if (resource === undefined || resource === "") return config.mcpUrl;
  if (typeof resource !== "string") return null;
  const strip = (s: string) => s.replace(/\/+$/, "");
  return strip(resource) === strip(config.mcpUrl) || strip(resource) === strip(config.baseUrl) ? config.mcpUrl : null;
}

function normalizeScope(scope: unknown): string | null {
  if (scope === undefined || scope === "") return config.scopes.join(" ");
  if (typeof scope !== "string") return null;
  const requested = scope.split(" ").filter(Boolean);
  return requested.every((s) => (config.scopes as readonly string[]).includes(s)) ? requested.join(" ") : null;
}

const oauthError = (res: Response, status: number, error: string, description: string) =>
  res.status(status).set("Cache-Control", "no-store").json({ error, error_description: description });

function issueTokens(grantId: string, clientId: string, userId: string, scope: string, resource: string) {
  const access = randomToken();
  const refresh = randomToken();
  const insert = db.prepare(
    `INSERT INTO oauth_tokens (token_hash, kind, grant_id, client_id, user_id, scope, resource, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(sha256(access), "access", grantId, clientId, userId, scope, resource, now() + config.accessTokenTtlSec);
  insert.run(sha256(refresh), "refresh", grantId, clientId, userId, scope, resource, now() + config.refreshTokenTtlSec);
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: config.accessTokenTtlSec,
    refresh_token: refresh,
    scope,
  };
}

export const revokeGrant = (grantId: string) =>
  db.prepare("UPDATE oauth_tokens SET revoked = 1 WHERE grant_id = ?").run(grantId);

/** Validated, normalized parameters of an authorization request. */
interface AuthzRequest {
  client: Client;
  redirect_uri: string;
  state: string | undefined;
  code_challenge: string;
  scope: string;
  resource: string;
}

/**
 * Validates an authorization request. Errors that make the redirect URI untrustworthy are shown
 * on our own page; everything else is sent back to the client per RFC 6749 §4.1.2.1.
 */
function parseAuthzRequest(
  params: Record<string, unknown>,
): { ok: true; value: AuthzRequest } | { ok: false; page?: string; redirect?: string } {
  const client = getClient(params.client_id);
  if (!client) return { ok: false, page: "Unknown client. Try reconnecting the app from ChatGPT or Claude." };
  const redirect_uri = params.redirect_uri;
  if (typeof redirect_uri !== "string" || !redirectUris(client).includes(redirect_uri)) {
    return { ok: false, page: "This redirect address isn't registered for this client." };
  }
  const state = typeof params.state === "string" ? params.state : undefined;
  const fail = (error: string, description: string) => {
    const u = new URL(redirect_uri);
    u.searchParams.set("error", error);
    u.searchParams.set("error_description", description);
    if (state) u.searchParams.set("state", state);
    u.searchParams.set("iss", config.baseUrl);
    return { ok: false as const, redirect: u.toString() };
  };
  if (params.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
  if (typeof params.code_challenge !== "string" || params.code_challenge.length < 43) {
    return fail("invalid_request", "PKCE code_challenge is required.");
  }
  if (params.code_challenge_method !== "S256") return fail("invalid_request", "code_challenge_method must be S256.");
  const scope = normalizeScope(params.scope);
  if (!scope) return fail("invalid_scope", `Supported scopes: ${config.scopes.join(", ")}.`);
  const resource = normalizeResource(params.resource);
  if (!resource) return fail("invalid_target", `Unknown resource. Use ${config.mcpUrl}.`);
  return { ok: true, value: { client, redirect_uri, state, code_challenge: params.code_challenge, scope, resource } };
}

/** CSRF token for the consent form, bound to the signed-in user and the exact request. */
const consentToken = (userId: string, req: AuthzRequest) =>
  sign(["consent", userId, req.client.client_id, req.redirect_uri, req.code_challenge, req.scope, req.resource, req.state ?? ""].join("|"));

export function oauthRouter(): Router {
  const router = Router();
  const form = express.urlencoded({ extended: false });

  // --- Dynamic Client Registration (RFC 7591) ---
  router.post("/oauth/register", express.json(), (req: Request, res: Response) => {
    const body = req.body ?? {};
    const uris: unknown = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === "string" && isAllowedRedirect(u))) {
      return oauthError(res, 400, "invalid_redirect_uri", "redirect_uris must be https (or loopback http) URLs.");
    }
    const method = body.token_endpoint_auth_method ?? "none";
    if (method !== "none") {
      return oauthError(res, 400, "invalid_client_metadata", "Only public clients (token_endpoint_auth_method=none) are supported.");
    }
    const client_id = newId("client");
    const client_name = typeof body.client_name === "string" ? body.client_name.slice(0, 100) : null;
    db.prepare("INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)").run(
      client_id, client_name, JSON.stringify(uris), now(),
    );
    res.status(201).set("Cache-Control", "no-store").json({
      client_id,
      client_id_issued_at: now(),
      client_name: client_name ?? undefined,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  // --- Authorization endpoint: sign in, then ask for consent ---
  router.get("/oauth/authorize", (req: Request, res: Response) => {
    const parsed = parseAuthzRequest(req.query as Record<string, unknown>);
    if (!parsed.ok) return parsed.redirect ? res.redirect(parsed.redirect) : res.status(400).send(errorPage(parsed.page!));
    const user = currentUser(req);
    if (!user) return res.redirect(`/signup?next=${encodeURIComponent(req.originalUrl)}`);
    res.set("X-Frame-Options", "DENY").send(
      consentPage({
        user,
        clientName: parsed.value.client.client_name ?? "An AI app",
        redirectHost: new URL(parsed.value.redirect_uri).host,
        scopes: parsed.value.scope.split(" "),
        hidden: {
          ...Object.fromEntries(Object.entries(req.query).filter(([, v]) => typeof v === "string")) as Record<string, string>,
          csrf: consentToken(user.id, parsed.value),
        },
      }),
    );
  });

  router.post("/oauth/authorize", form, (req: Request, res: Response) => {
    const parsed = parseAuthzRequest(req.body);
    if (!parsed.ok) return parsed.redirect ? res.redirect(303, parsed.redirect) : res.status(400).send(errorPage(parsed.page!));
    const user = currentUser(req);
    if (!user) return res.status(401).send(errorPage("Your session expired. Go back to the chat and connect again."));
    const a = parsed.value;
    if (typeof req.body.csrf !== "string" || !safeEqual(req.body.csrf, consentToken(user.id, a))) {
      return res.status(400).send(errorPage("This approval form expired. Go back to the chat and connect again."));
    }
    const redirect = new URL(a.redirect_uri);
    if (a.state) redirect.searchParams.set("state", a.state);
    redirect.searchParams.set("iss", config.baseUrl); // RFC 9207 mix-up protection
    if (req.body.decision !== "approve") {
      redirect.searchParams.set("error", "access_denied");
      return res.redirect(303, redirect.toString());
    }
    const code = randomToken();
    db.prepare(
      `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(sha256(code), a.client.client_id, user.id, a.redirect_uri, a.code_challenge, a.scope, a.resource, now() + config.authCodeTtlSec);
    redirect.searchParams.set("code", code);
    res.redirect(303, redirect.toString());
  });

  // --- Token endpoint ---
  router.post("/oauth/token", form, (req: Request, res: Response) => {
    const b = req.body ?? {};
    const client = getClient(b.client_id);
    if (!client) return oauthError(res, 401, "invalid_client", "Unknown client_id.");

    if (b.grant_type === "authorization_code") {
      if (typeof b.code !== "string" || typeof b.code_verifier !== "string") {
        return oauthError(res, 400, "invalid_request", "code and code_verifier are required.");
      }
      const codeHash = sha256(b.code);
      const row = db.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?").get(codeHash) as
        | { client_id: string; user_id: string; redirect_uri: string; code_challenge: string; scope: string; resource: string; expires_at: number }
        | undefined;
      // Codes are single-use: delete before validating so a replay always fails.
      db.prepare("DELETE FROM oauth_codes WHERE code_hash = ?").run(codeHash);
      if (!row || row.expires_at < now() || row.client_id !== client.client_id) {
        return oauthError(res, 400, "invalid_grant", "Authorization code is invalid or expired.");
      }
      if (b.redirect_uri !== row.redirect_uri) return oauthError(res, 400, "invalid_grant", "redirect_uri mismatch.");
      if (!safeEqual(pkceChallenge(b.code_verifier), row.code_challenge)) {
        return oauthError(res, 400, "invalid_grant", "PKCE verification failed.");
      }
      if (b.resource && normalizeResource(b.resource) !== row.resource) {
        return oauthError(res, 400, "invalid_target", "resource does not match the authorization request.");
      }
      return res.set("Cache-Control", "no-store").json(issueTokens(newId("grant"), client.client_id, row.user_id, row.scope, row.resource));
    }

    if (b.grant_type === "refresh_token") {
      if (typeof b.refresh_token !== "string") return oauthError(res, 400, "invalid_request", "refresh_token is required.");
      const row = db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'").get(sha256(b.refresh_token)) as
        | { grant_id: string; client_id: string; user_id: string; scope: string; resource: string; expires_at: number; revoked: number }
        | undefined;
      if (!row || row.client_id !== client.client_id || row.expires_at < now()) {
        return oauthError(res, 400, "invalid_grant", "Refresh token is invalid or expired.");
      }
      if (row.revoked) {
        // A rotated-out refresh token was used again: assume it leaked and kill the whole grant.
        revokeGrant(row.grant_id);
        return oauthError(res, 400, "invalid_grant", "Refresh token was already used.");
      }
      // Rotation: the old refresh token (and older access tokens) stop working.
      revokeGrant(row.grant_id);
      return res.set("Cache-Control", "no-store").json(issueTokens(row.grant_id, client.client_id, row.user_id, row.scope, row.resource));
    }

    return oauthError(res, 400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
  });

  // --- Revocation (RFC 7009): always 200, even for unknown tokens ---
  router.post("/oauth/revoke", form, (req: Request, res: Response) => {
    const token = req.body?.token;
    if (typeof token === "string") {
      const row = db.prepare("SELECT grant_id, client_id FROM oauth_tokens WHERE token_hash = ?").get(sha256(token)) as
        | { grant_id: string; client_id: string }
        | undefined;
      if (row && row.client_id === req.body.client_id) revokeGrant(row.grant_id);
    }
    res.status(200).end();
  });

  return router;
}

/** Used by the MCP SDK's requireBearerAuth middleware to validate access tokens on /mcp. */
export const tokenVerifier: OAuthTokenVerifier = {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = db
      .prepare("SELECT client_id, user_id, scope, resource, expires_at, revoked FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'")
      .get(sha256(token)) as
      | { client_id: string; user_id: string; scope: string; resource: string; expires_at: number; revoked: number }
      | undefined;
    if (!row || row.revoked || row.expires_at < now() || !getUser(row.user_id)) {
      // The SDK maps invalid_token to a 401 with a WWW-Authenticate challenge pointing at our metadata.
      throw new OAuthError("invalid_token", "Invalid or expired access token");
    }
    return {
      token,
      clientId: row.client_id,
      scopes: row.scope.split(" "),
      expiresAt: row.expires_at,
      resource: new URL(row.resource),
      extra: { userId: row.user_id },
    };
  },
};

/** Apps the user has connected (active grants), for the account page. */
export const connectedApps = (userId: string) =>
  db
    .prepare(
      `SELECT t.grant_id, c.client_name, MAX(t.expires_at) AS expires_at
         FROM oauth_tokens t JOIN oauth_clients c ON c.client_id = t.client_id
        WHERE t.user_id = ? AND t.kind = 'refresh' AND t.revoked = 0 AND t.expires_at > ?
        GROUP BY t.grant_id ORDER BY expires_at DESC`,
    )
    .all(userId, now()) as { grant_id: string; client_name: string | null; expires_at: number }[];
