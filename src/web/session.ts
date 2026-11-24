import type { NextFunction, Request, Response } from "express";
import { isProd } from "../config.js";
import { randomToken, sha256 } from "../crypto.js";
import { db, now } from "../db.js";
import { getUser, type User } from "../users.js";

const COOKIE = "ps_session";
const TTL = 60 * 60 * 24 * 7;

export function startSession(res: Response, userId: string) {
  const raw = randomToken();
  db.prepare("INSERT INTO web_sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(raw), userId, now() + TTL);
  res.cookie(COOKIE, raw, { httpOnly: true, sameSite: "lax", secure: isProd, maxAge: TTL * 1000, path: "/" });
}

export function endSession(req: Request, res: Response) {
  const raw = req.cookies?.[COOKIE];
  if (raw) db.prepare("DELETE FROM web_sessions WHERE id = ?").run(sha256(raw));
  res.clearCookie(COOKIE, { path: "/" });
}

export function currentUser(req: Request): User | undefined {
  const raw = req.cookies?.[COOKIE];
  if (!raw) return undefined;
  const row = db
    .prepare("SELECT user_id FROM web_sessions WHERE id = ? AND expires_at > ?")
    .get(sha256(raw), now()) as { user_id: string } | undefined;
  return row ? getUser(row.user_id) : undefined;
}

/** Redirects to /login (returning here afterwards) when nobody is signed in. */
export function requireLogin(req: Request, res: Response, next: NextFunction) {
  const user = currentUser(req);
  if (!user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  res.locals.user = user;
  next();
}

/** Only allow same-site relative paths as post-login redirects (prevents open redirects). */
export const safeNext = (value: unknown, fallback = "/account") =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : fallback;
