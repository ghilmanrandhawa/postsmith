import "dotenv/config";

const baseUrl = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

export const config = {
  baseUrl,
  port: Number(process.env.PORT ?? 3000),
  appSecret: process.env.APP_SECRET ?? "dev-secret-change-me",
  dbPath: process.env.DB_PATH ?? "data/postsmith.db",
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || undefined,
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || undefined,

  /** The MCP endpoint is also the OAuth "resource" (RFC 8707) tokens are bound to. */
  mcpUrl: `${baseUrl}/mcp`,

  accessTokenTtlSec: 60 * 60, // 1 hour
  refreshTokenTtlSec: 60 * 60 * 24 * 30, // 30 days
  authCodeTtlSec: 60 * 5, // 5 minutes

  signupCredits: 3,
  creditsPerPost: 1,
  /** Credit packs sold through Stripe Checkout (prices in USD cents). */
  creditPacks: [
    { id: "pack_10", credits: 10, priceCents: 500 },
    { id: "pack_50", credits: 50, priceCents: 2000 },
  ],
  scopes: ["posts:write", "posts:read"],
} as const;

export const isProd = config.baseUrl.startsWith("https://");
