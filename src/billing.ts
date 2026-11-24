/**
 * Prepaid credits via Stripe Checkout (test mode).
 *
 * Credits are granted from the `checkout.session.completed` webhook. The success page also
 * re-checks the session with Stripe, so local setups without a webhook tunnel still work.
 * Both paths go through addCredits(…, "purchase", session.id), which is idempotent.
 * Without STRIPE_SECRET_KEY, a "dev top-up" grants credits directly so the demo runs offline.
 */
import express, { type Request, type Response, Router } from "express";
import Stripe from "stripe";
import { config } from "./config.js";
import { newId } from "./crypto.js";
import { addCredits } from "./users.js";
import { requireLogin } from "./web/session.js";

const stripe = config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : undefined;
export const billingMode = stripe ? "stripe" : "dev";

function grantFromSession(session: Stripe.Checkout.Session) {
  if (session.payment_status !== "paid") return false;
  const userId = session.metadata?.userId;
  const credits = Number(session.metadata?.credits);
  if (!userId || !Number.isInteger(credits) || credits <= 0) return false;
  return addCredits(userId, credits, "purchase", session.id);
}

export function billingRouter(): Router {
  const router = Router();

  router.post("/billing/checkout", express.urlencoded({ extended: false }), requireLogin, async (req: Request, res: Response) => {
    const pack = config.creditPacks.find((p) => p.id === req.body.pack);
    if (!pack) return res.status(400).send("Unknown credit pack.");
    const user = res.locals.user;

    if (!stripe) {
      addCredits(user.id, pack.credits, "dev_topup", newId("dev"));
      return res.redirect(303, "/account?topped_up=1#credits");
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: user.email,
      client_reference_id: user.id,
      metadata: { userId: user.id, credits: String(pack.credits), pack: pack.id },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: pack.priceCents,
            product_data: { name: `${pack.credits} Postsmith credits` },
          },
        },
      ],
      success_url: `${config.baseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.baseUrl}/account#credits`,
    });
    res.redirect(303, session.url!);
  });

  router.get("/billing/success", requireLogin, async (req: Request, res: Response) => {
    if (stripe && typeof req.query.session_id === "string") {
      try {
        const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
        if (session.metadata?.userId === res.locals.user.id) grantFromSession(session);
      } catch (err) {
        console.error("[billing] could not verify session", err);
      }
    }
    res.redirect(303, "/account?topped_up=1#credits");
  });

  // Stripe needs the raw body to verify the signature, so this route parses it itself.
  router.post("/billing/webhook", express.raw({ type: "application/json" }), (req: Request, res: Response) => {
    if (!stripe || !config.stripeWebhookSecret) return res.status(404).end();
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.header("stripe-signature") ?? "", config.stripeWebhookSecret);
    } catch {
      return res.status(400).send("Invalid signature");
    }
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      grantFromSession(event.data.object as Stripe.Checkout.Session);
    }
    res.json({ received: true });
  });

  return router;
}
