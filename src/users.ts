import { config } from "./config.js";
import { hashPassword, newId, verifyPassword } from "./crypto.js";
import { db, now } from "./db.js";

export interface User {
  id: string;
  email: string;
  credits: number;
  created_at: number;
}

export class InsufficientCreditsError extends Error {
  constructor(public balance: number) {
    super(`Not enough credits (balance: ${balance}).`);
  }
}

export const getUser = (id: string) =>
  db.prepare("SELECT id, email, credits, created_at FROM users WHERE id = ?").get(id) as User | undefined;

export function createUser(email: string, password: string): User {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("Enter a valid email address.");
  if (password.length < 8) throw new Error("Password must be at least 8 characters.");
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(normalized)) {
    throw new Error("An account with this email already exists. Log in instead.");
  }
  const id = newId("usr");
  db.transaction(() => {
    db.prepare("INSERT INTO users (id, email, password_hash, credits, created_at) VALUES (?, ?, ?, 0, ?)").run(
      id, normalized, hashPassword(password), now(),
    );
    addCredits(id, config.signupCredits, "signup", id);
  })();
  return getUser(id)!;
}

export function authenticate(email: string, password: string): User | undefined {
  const row = db
    .prepare("SELECT id, password_hash FROM users WHERE email = ?")
    .get(email.trim().toLowerCase()) as { id: string; password_hash: string } | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) return undefined;
  return getUser(row.id);
}

/**
 * Adds credits and records them in the ledger. Returns false (and changes nothing)
 * when this (reason, ref) was already applied — so a retried Stripe webhook can't double-credit.
 */
export function addCredits(userId: string, amount: number, reason: string, ref: string | null): boolean {
  return db.transaction(() => {
    const inserted = db
      .prepare("INSERT OR IGNORE INTO credit_ledger (user_id, delta, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(userId, amount, reason, ref, now());
    if (inserted.changes === 0) return false;
    db.prepare("UPDATE users SET credits = credits + ? WHERE id = ?").run(amount, userId);
    return true;
  })();
}

/** Atomically spends credits, or throws InsufficientCreditsError. */
export function spendCredits(userId: string, amount: number, reason: string, ref: string) {
  db.transaction(() => {
    const res = db
      .prepare("UPDATE users SET credits = credits - ? WHERE id = ? AND credits >= ?")
      .run(amount, userId, amount);
    if (res.changes === 0) throw new InsufficientCreditsError(getUser(userId)?.credits ?? 0);
    db.prepare("INSERT INTO credit_ledger (user_id, delta, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(userId, -amount, reason, ref, now());
  })();
}

export const recentLedger = (userId: string) =>
  db
    .prepare("SELECT delta, reason, ref, created_at FROM credit_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 15")
    .all(userId) as { delta: number; reason: string; ref: string | null; created_at: number }[];
