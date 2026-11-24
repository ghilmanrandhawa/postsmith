import express, { type Request, type Response, Router } from "express";
import { connectedApps } from "../auth/oauth.js";
import { billingMode } from "../billing.js";
import { db } from "../db.js";
import { listPosts, pngForDownload } from "../posts.js";
import { authenticate, createUser, recentLedger } from "../users.js";
import { accountPage, authPage, homePage } from "./pages.js";
import { currentUser, endSession, requireLogin, safeNext, startSession } from "./session.js";

export function webRouter(): Router {
  const router = Router();
  const form = express.urlencoded({ extended: false });

  router.get("/", (req, res) => res.send(homePage(currentUser(req))));

  router.get("/signup", (req, res) => res.send(authPage("signup", { next: safeNext(req.query.next) })));
  router.post("/signup", form, (req: Request, res: Response) => {
    const next = safeNext(req.body.next);
    try {
      const user = createUser(String(req.body.email ?? ""), String(req.body.password ?? ""));
      startSession(res, user.id);
      res.redirect(303, next);
    } catch (err) {
      res.status(400).send(authPage("signup", { next, error: (err as Error).message, email: req.body.email }));
    }
  });

  router.get("/login", (req, res) => res.send(authPage("login", { next: safeNext(req.query.next) })));
  router.post("/login", form, (req: Request, res: Response) => {
    const next = safeNext(req.body.next);
    const user = authenticate(String(req.body.email ?? ""), String(req.body.password ?? ""));
    if (!user) {
      return res.status(401).send(authPage("login", { next, error: "Wrong email or password.", email: req.body.email }));
    }
    startSession(res, user.id);
    res.redirect(303, next);
  });

  router.get("/logout", (req, res) => {
    endSession(req, res);
    res.redirect(safeNext(req.query.next, "/"));
  });

  router.get("/account", requireLogin, (req, res) => {
    const user = res.locals.user;
    res.send(
      accountPage({
        user,
        toppedUp: req.query.topped_up === "1",
        billingMode,
        apps: connectedApps(user.id),
        posts: listPosts(user.id),
        ledger: recentLedger(user.id),
      }),
    );
  });

  router.post("/account/disconnect", form, requireLogin, (req, res) => {
    db.prepare("UPDATE oauth_tokens SET revoked = 1 WHERE grant_id = ? AND user_id = ?").run(String(req.body.grant), res.locals.user.id);
    res.redirect(303, "/account");
  });

  // Signed, expiring image download (works from the chat without a browser session).
  router.get("/p/:file", async (req, res) => {
    const id = req.params.file.replace(/\.png$/, "");
    const png = await pngForDownload(id, Number(req.query.exp), String(req.query.sig ?? ""));
    if (!png) return res.status(404).send("This download link is invalid or has expired. Ask the assistant for a fresh one.");
    res.type("png").set("Content-Disposition", `attachment; filename="${id}.png"`).send(png);
  });

  return router;
}
