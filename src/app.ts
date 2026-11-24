import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthMetadataRouter, requireBearerAuth } from "@modelcontextprotocol/express";
import { oauthMetadata, oauthRouter, tokenVerifier } from "./auth/oauth.js";
import { billingRouter } from "./billing.js";
import { config, isProd } from "./config.js";
import { buildMcpServer } from "./mcp.js";
import { webRouter } from "./web/routes.js";

/** MCP clients that run in a browser (e.g. MCP Inspector) need CORS on the API surface. */
function cors(req: Request, res: Response, next: NextFunction) {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
    "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
  });
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
}

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(cookieParser());

  app.use(["/.well-known", "/oauth/token", "/oauth/register", "/oauth/revoke", "/mcp"], cors);

  // RFC 8414 authorization server metadata + RFC 9728 protected resource metadata.
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata,
      resourceServerUrl: new URL(config.mcpUrl),
      scopesSupported: [...config.scopes],
      resourceName: "Postsmith",
      dangerouslyAllowInsecureIssuerUrl: !isProd, // plain http is only accepted for localhost development
    }),
  );

  app.use(billingRouter()); // before any JSON parser: the Stripe webhook needs the raw body
  app.use(oauthRouter());
  app.use(webRouter());

  // --- MCP endpoint: bearer token required; 401 responses point clients at our OAuth metadata ---
  const mcp = toNodeHandler(
    createMcpHandler((ctx) => buildMcpServer(ctx.authInfo?.extra?.userId as string | undefined), {
      onerror: (err) => console.error("[mcp]", err),
    }),
  );
  app.all(
    "/mcp",
    requireBearerAuth({
      verifier: tokenVerifier,
      requiredScopes: ["posts:read"],
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(config.mcpUrl)),
    }),
    express.json({ limit: "1mb" }),
    (req, res) => mcp(req, res, req.body),
  );

  return app;
}
