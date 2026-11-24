import { readFileSync } from "node:fs";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { config, isProd } from "./config.js";
import { createPost, getPost, listPosts, PostValidationError, schedulePost } from "./posts.js";
import { PLATFORMS, THEMES } from "./render.js";
import { getUser, InsufficientCreditsError } from "./users.js";

export const WIDGET_URI = "ui://postsmith/post.html";

let widgetHtml: string | undefined;
const readWidget = () => readFileSync(new URL("../dist/widget/index.html", import.meta.url), "utf8");
// Cached in production; re-read in development so `npm run build:widget` shows up without a restart.
const loadWidget = () => (isProd ? (widgetHtml ??= readWidget()) : readWidget());

const topUpUrl = `${config.baseUrl}/account#credits`;

const ok = (text: string, structuredContent: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text }],
  structuredContent,
});
const fail = (text: string, structuredContent: Record<string, unknown> = {}): CallToolResult => ({
  content: [{ type: "text", text }],
  structuredContent: { error: text, ...structuredContent },
  isError: true,
});

function account(userId: string) {
  const user = getUser(userId)!;
  return { email: user.email, credits: user.credits, creditsPerPost: config.creditsPerPost, topUpUrl };
}

/** Tells the model what to do next — this matters as much as the widget for clients without UI. */
function describe(post: NonNullable<ReturnType<typeof getPost>>) {
  switch (post.status) {
    case "queued":
    case "generating":
      return `Post ${post.id} is generating (${post.progress}% — ${post.step}). The preview card in the chat updates on its own; if no card is shown, call get_post with this id in a few seconds.`;
    case "ready":
      return `Post ${post.id} for ${post.platformLabel} is ready. Download: ${post.downloadUrl}\n\nCaption:\n${post.fullCaption}\n\nAsk the user whether to schedule it (schedule_post) or change anything.`;
    case "scheduled":
      return `Post ${post.id} is scheduled for ${post.scheduledAt} on ${post.platformLabel}.`;
    case "failed":
      return `Post ${post.id} failed: ${post.error}`;
  }
}

/** One fresh server per request (stateless), scoped to the signed-in user from the access token. */
export function buildMcpServer(userId: string | undefined) {
  const server = new McpServer(
    { name: "postsmith", title: "Postsmith", version: "0.1.0" },
    {
      instructions:
        "Postsmith turns a short brief into a finished social media post (copy + image) for Instagram, LinkedIn or X, " +
        "then lets the user download or schedule it. You write the headline, caption and hashtags yourself from the user's brief, " +
        "then call create_post. Each post costs 1 credit.",
    },
  );

  const requireUser = () => {
    if (!userId || !getUser(userId)) throw new Error("Not signed in. Reconnect Postsmith to link your account.");
    return userId;
  };

  registerAppResource(server, "Postsmith post preview", WIDGET_URI, { description: "Live progress and preview of a generated post" }, async () => ({
    contents: [{ uri: WIDGET_URI, mimeType: RESOURCE_MIME_TYPE, text: loadWidget() }],
  }));

  registerAppTool(
    server,
    "create_post",
    {
      title: "Create social post",
      description:
        "Generate a finished social media post (image + caption) from a brief. Write a punchy headline for the image, " +
        "a platform-appropriate caption, and a few relevant hashtags yourself before calling. Costs 1 credit. " +
        "Generation takes ~10 seconds; the returned card shows live progress.",
      inputSchema: z.object({
        platform: z.enum(Object.keys(PLATFORMS) as [keyof typeof PLATFORMS]).describe("Where the post will be published."),
        brief: z.string().min(5).max(500).describe("What the post is about, in the user's words (also used as the image subline)."),
        headline: z.string().min(3).max(80).describe("Short, punchy text for the image (max ~8 words)."),
        caption: z.string().min(1).max(2500).describe("Post caption without hashtags. Keep X posts very short."),
        hashtags: z.array(z.string().max(40)).max(10).default([]).describe("Hashtags without the # sign."),
        theme: z.enum(Object.keys(THEMES) as [keyof typeof THEMES]).default("ocean").describe("Visual colour theme."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: WIDGET_URI } },
    },
    async (args) => {
      const uid = requireUser();
      try {
        const post = createPost(uid, args);
        return ok(describe(post), { post, account: account(uid) });
      } catch (err) {
        if (err instanceof InsufficientCreditsError) {
          return fail(
            `The user is out of credits (balance ${err.balance}). Ask them to top up at ${topUpUrl} — it takes under a minute — then try again.`,
            { account: account(uid), reason: "insufficient_credits" },
          );
        }
        if (err instanceof PostValidationError) return fail(err.message, { reason: "validation" });
        throw err;
      }
    },
  );

  registerAppTool(
    server,
    "get_post",
    {
      title: "Get post status",
      description: "Get the status, progress, preview and download link of a post created with create_post.",
      inputSchema: z.object({ id: z.string().describe("Post id, e.g. post_abc123") }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: WIDGET_URI, visibility: ["model", "app"] } },
    },
    async ({ id }) => {
      const uid = requireUser();
      const post = getPost(uid, id);
      if (!post) return fail(`No post with id ${id} on this account.`);
      return ok(describe(post), { post, account: account(uid) });
    },
  );

  registerAppTool(
    server,
    "schedule_post",
    {
      title: "Schedule post",
      description: "Schedule a ready post for publishing at a specific time. Confirm the time (and the user's timezone) before calling.",
      inputSchema: z.object({
        id: z.string(),
        publish_at: z.string().describe("ISO 8601 date-time with timezone offset, e.g. 2026-12-01T09:00:00+05:00"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: { ui: { resourceUri: WIDGET_URI, visibility: ["model", "app"] } },
    },
    async ({ id, publish_at }) => {
      const uid = requireUser();
      try {
        const post = schedulePost(uid, id, new Date(publish_at));
        return ok(describe(post), { post, account: account(uid) });
      } catch (err) {
        if (err instanceof PostValidationError) return fail(err.message);
        throw err;
      }
    },
  );

  server.registerTool(
    "list_posts",
    {
      title: "List recent posts",
      description: "List the user's 10 most recent posts with their status.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const uid = requireUser();
      const posts = listPosts(uid);
      const text = posts.length
        ? posts.map((p) => `• ${p.id} — ${p.platformLabel} — "${p.headline}" — ${p.status}`).join("\n")
        : "No posts yet.";
      return ok(text, { posts });
    },
  );

  server.registerTool(
    "get_account",
    {
      title: "Get credit balance",
      description: "Show the linked Postsmith account and its remaining credits.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const uid = requireUser();
      const a = account(uid);
      return ok(`${a.email} has ${a.credits} credit(s). Each post costs ${a.creditsPerPost}. Top up: ${a.topUpUrl}`, a);
    },
  );

  return server;
}
