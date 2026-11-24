import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString("base64url")}`;
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** base64url(SHA-256(verifier)) — the PKCE S256 transform (RFC 7636 §4.2). */
export const pkceChallenge = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string) {
  const [, salt, hash] = stored.split("$");
  if (!salt || !hash) return false;
  return safeEqual(scryptSync(password, salt, 64).toString("hex"), hash);
}

/** HMAC signature for short-lived, unauthenticated links (e.g. image downloads). */
export const sign = (value: string) =>
  createHmac("sha256", config.appSecret).update(value).digest("base64url");
