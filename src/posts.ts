/**
 * Post generation as a long-running background job.
 *
 * create_post returns immediately with a post id; the job advances through named steps and
 * the in-chat widget polls get_post to show progress. In a real deployment this would call
 * the content backend (LLM copy, image model, brand checks) — here each step is simulated
 * with a delay, and the visual is rendered locally. Failed jobs refund their credit.
 */
import { config } from "./config.js";
import { newId, safeEqual, sign } from "./crypto.js";
import { db, now } from "./db.js";
import { PLATFORMS, type Platform, renderPng, renderSvg, type Theme } from "./render.js";
import { addCredits, spendCredits } from "./users.js";

export type PostStatus = "queued" | "generating" | "ready" | "failed" | "scheduled";

interface PostRow {
  id: string;
  user_id: string;
  platform: Platform;
  brief: string;
  headline: string;
  caption: string;
  hashtags: string;
  theme: Theme;
  status: PostStatus;
  progress: number;
  step: string;
  error: string | null;
  scheduled_at: number | null;
  created_at: number;
}

export interface NewPost {
  platform: Platform;
  brief: string;
  headline: string;
  caption: string;
  hashtags: string[];
  theme: Theme;
}

export class PostValidationError extends Error {}

const STEPS: { label: string; ms: number }[] = [
  { label: "Reading the brief", ms: 900 },
  { label: "Polishing the copy", ms: 1500 },
  { label: "Designing the visual", ms: 2000 },
  { label: "Rendering the image", ms: 1500 },
  { label: "Running brand checks", ms: 900 },
];

/** Step delays can be shortened for tests. */
let speed = Number(process.env.POSTSMITH_JOB_SPEED ?? 1);
export const setJobSpeed = (s: number) => (speed = s);

const fullCaption = (caption: string, hashtags: string[]) =>
  [caption.trim(), hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ")].filter(Boolean).join("\n\n");

export function createPost(userId: string, input: NewPost) {
  const limit = PLATFORMS[input.platform].captionLimit;
  const length = fullCaption(input.caption, input.hashtags).length;
  if (length > limit) {
    throw new PostValidationError(
      `The caption plus hashtags is ${length} characters, but ${PLATFORMS[input.platform].label} allows ${limit}. Shorten it by ${length - limit} characters and try again.`,
    );
  }
  const id = newId("post");
  db.transaction(() => {
    spendCredits(userId, config.creditsPerPost, "post", id); // throws InsufficientCreditsError
    db.prepare(
      `INSERT INTO posts (id, user_id, platform, brief, headline, caption, hashtags, theme, status, progress, step, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 'Queued', ?)`,
    ).run(id, userId, input.platform, input.brief, input.headline, input.caption, JSON.stringify(input.hashtags), input.theme, now());
  })();
  void runJob(id);
  return getPost(userId, id)!;
}

async function runJob(id: string) {
  const update = db.prepare("UPDATE posts SET status = ?, progress = ?, step = ? WHERE id = ?");
  try {
    for (let i = 0; i < STEPS.length; i++) {
      update.run("generating", Math.round((i / STEPS.length) * 100), STEPS[i].label, id);
      await new Promise((r) => setTimeout(r, STEPS[i].ms * speed));
    }
    const row = db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as PostRow;
    await renderPng(cardFor(row)); // make sure the final asset actually renders before calling it ready
    update.run("ready", 100, "Ready", id);
  } catch (err) {
    failJob(id, "Rendering failed on our side. Your credit was refunded — please try again.");
    console.error(`[job ${id}]`, err);
  }
}

function failJob(id: string, message: string) {
  const row = db.prepare("SELECT user_id, status FROM posts WHERE id = ?").get(id) as { user_id: string; status: string } | undefined;
  if (!row || row.status === "failed") return;
  db.prepare("UPDATE posts SET status = 'failed', step = 'Failed', error = ? WHERE id = ?").run(message, id);
  addCredits(row.user_id, config.creditsPerPost, "refund", id);
}

/** Jobs live in memory; anything interrupted by a restart is failed and refunded. */
export function recoverInterruptedJobs() {
  const stuck = db.prepare("SELECT id FROM posts WHERE status IN ('queued', 'generating')").all() as { id: string }[];
  for (const { id } of stuck) failJob(id, "The server restarted while this post was generating. Your credit was refunded — please try again.");
}

const cardFor = (row: Pick<PostRow, "platform" | "theme" | "headline" | "brief">) => ({
  platform: row.platform,
  theme: row.theme,
  headline: row.headline,
  subline: row.brief.length > 110 ? row.brief.slice(0, 107) + "…" : row.brief,
});

/** Download links are signed and expire, so they work outside the chat without a session. */
export function downloadUrl(id: string, ttlSec = 60 * 60 * 24) {
  const exp = now() + ttlSec;
  return `${config.baseUrl}/p/${id}.png?exp=${exp}&sig=${sign(`${id}.${exp}`)}`;
}

export async function pngForDownload(id: string, exp: number, sig: string) {
  if (!(exp > now()) || !safeEqual(sig, sign(`${id}.${exp}`))) return undefined;
  const row = db.prepare("SELECT * FROM posts WHERE id = ? AND status IN ('ready', 'scheduled')").get(id) as PostRow | undefined;
  return row ? renderPng(cardFor(row)) : undefined;
}

/** The public shape returned to the model and widget. */
function toView(row: PostRow) {
  const done = row.status === "ready" || row.status === "scheduled";
  const hashtags = JSON.parse(row.hashtags) as string[];
  return {
    id: row.id,
    platform: row.platform,
    platformLabel: PLATFORMS[row.platform].label,
    theme: row.theme,
    headline: row.headline,
    caption: row.caption,
    hashtags,
    fullCaption: fullCaption(row.caption, hashtags),
    status: row.status,
    progress: row.progress,
    step: row.step,
    error: row.error,
    scheduledAt: row.scheduled_at ? new Date(row.scheduled_at * 1000).toISOString() : null,
    createdAt: new Date(row.created_at * 1000).toISOString(),
    previewSvg: done ? renderSvg(cardFor(row)) : null,
    downloadUrl: done ? downloadUrl(row.id) : null,
  };
}
export type PostView = ReturnType<typeof toView>;

export function getPost(userId: string, id: string): PostView | undefined {
  const row = db.prepare("SELECT * FROM posts WHERE id = ? AND user_id = ?").get(id, userId) as PostRow | undefined;
  return row ? toView(row) : undefined;
}

export function listPosts(userId: string, limit = 10) {
  const rows = db.prepare("SELECT * FROM posts WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(userId, limit) as PostRow[];
  return rows.map((r) => {
    const { previewSvg: _drop, ...rest } = toView(r);
    return rest;
  });
}

export function schedulePost(userId: string, id: string, when: Date) {
  const post = getPost(userId, id);
  if (!post) throw new PostValidationError("Post not found.");
  if (post.status !== "ready" && post.status !== "scheduled") {
    throw new PostValidationError(`This post is ${post.status}; it can only be scheduled once it's ready.`);
  }
  if (Number.isNaN(when.getTime()) || when.getTime() < Date.now() + 60_000) {
    throw new PostValidationError("Pick a time at least one minute in the future.");
  }
  db.prepare("UPDATE posts SET status = 'scheduled', scheduled_at = ? WHERE id = ?").run(Math.floor(when.getTime() / 1000), id);
  return getPost(userId, id)!;
}
