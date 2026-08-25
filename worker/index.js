/* ==========================================================================
   D. SANT enquiry endpoint
   ---------------------------------------------------------------------------
   POST /api/enquiry

   Everything here assumes the client is hostile. Browser-side validation is a
   convenience for honest users; this file is the actual gate.

   Flow: origin check -> rate limit -> parse -> validate -> store -> notify.
   Storage happens BEFORE notification on purpose: an enquiry that is saved but
   not emailed can be recovered from the database, whereas one that is emailed
   but not saved is gone the moment the inbox is cleared.
   ========================================================================== */

const MAX_BODY_BYTES = 16 * 1024; // an enquiry is ~1KB; this is generous
const RATE_LIMIT = { max: 5, windowSeconds: 3600 };

/* A second limit keyed on the submitted email address. Per-IP alone lets
   someone cycle addresses through a proxy pool and use this form to mail
   strangers a confirmation they never asked for - the form becomes a spam
   cannon pointed at third parties. */
const EMAIL_LIMIT = { max: 3, windowSeconds: 86400 };

const MIN_QTY = 100; // wholesale only

/* Retention. The privacy policy commits to deleting enquiries after 24
   months, so something has to actually do it - see the scheduled handler. */
const RETENTION_DAYS = 730;

/* Field length caps. Anything longer is a mistake or an attack, never a real
   enquiry, and unbounded strings are how a database bill becomes a surprise. */
const LIMITS = {
  name: 100, company: 120, buyerType: 60, gstin: 15,
  email: 254, phone: 24, product: 120, branding: 60, message: 4000,
};

const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

/* ── helpers ─────────────────────────────────────────────────────────────── */

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/* Read the body with a hard byte ceiling, aborting the stream the moment it
   is exceeded. Returns null if over the cap. Never buffers more than `max`. */
async function readCapped(request, max) {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

/* Every outbound call gets a deadline. Without one, a hung upstream holds the
   waitUntil open until the platform kills it, and a slow Turnstile response
   would stall the request the visitor is waiting on. */
const withTimeout = (ms) => AbortSignal.timeout(ms);

/* Strip CR/LF before any value reaches a mail header or the Telegram API.
   This is the classic contact-form-to-spam-relay vector: a newline inside a
   "name" lets an attacker inject their own Bcc: header. */
/* U+2028 and U+2029 are written as escapes, not literal characters:
   JavaScript treats both as line terminators, so a raw one inside a
   regex literal ends the line and breaks the file. */
const noCRLF = (s) =>
  s.replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, " ");

/* Escape for the HTML email body. Enquiry text is attacker-controlled and the
   owner opens it in a mail client that renders HTML. */
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+]?[0-9\s-]{7,24}$/;
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][Z][0-9A-Z]$/;

/* ── rate limiting ───────────────────────────────────────────────────────── */

/* Fails open on a KV outage. A rate limiter that blocks every enquiry when
   its own storage is unavailable costs more than the abuse it prevents. */
async function bump(env, key, max, ttl) {
  if (!env.RATELIMIT) return false;
  try {
    const current = parseInt((await env.RATELIMIT.get(key)) || "0", 10);
    if (current >= max) return true;
    await env.RATELIMIT.put(key, String(current + 1), { expirationTtl: ttl });
    return false;
  } catch {
    return false;
  }
}

const rateLimited = (env, ip) =>
  bump(env, `rl:${ip}`, RATE_LIMIT.max, RATE_LIMIT.windowSeconds);

/* Hashed, not stored raw: the limiter should not become a second copy of
   every email address that ever touched the form. */
async function emailLimited(env, email) {
  /* Fails open, like bump() does. Every other limb of the limiter tolerates
     its own failure; without this guard a throw here would 500 an enquiry
     that is otherwise completely valid. */
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
    const hash = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return bump(env, `el:${hash.slice(0, 32)}`, EMAIL_LIMIT.max, EMAIL_LIMIT.windowSeconds);
  } catch {
    return false;
  }
}

/* Cloudflare Turnstile. Dormant until TURNSTILE_SECRET is set, so the site
   keeps working before the keys exist; once set it becomes the real bot gate
   and the honeypot drops to a backstop. */
async function turnstileOk(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
      signal: withTimeout(5000), // visitor is blocked on this one
    });
    const out = await res.json();
    return out.success === true;
  } catch {
    return false; // fail closed: this one exists precisely to stop bots
  }
}

/* ── validation ──────────────────────────────────────────────────────────── */

function validate(raw) {
  const d = {
    name: noCRLF(str(raw.name, LIMITS.name)),
    company: noCRLF(str(raw.company, LIMITS.company)),
    buyerType: noCRLF(str(raw.buyerType, LIMITS.buyerType)),
    gstin: noCRLF(str(raw.gstin, LIMITS.gstin)).toUpperCase(),
    email: noCRLF(str(raw.email, LIMITS.email)).toLowerCase(),
    phone: noCRLF(str(raw.phone, LIMITS.phone)),
    product: noCRLF(str(raw.product, LIMITS.product)),
    branding: noCRLF(str(raw.branding, LIMITS.branding)),
    message: str(raw.message, LIMITS.message), // newlines are legitimate here
    quantity: Number.isFinite(+raw.quantity) ? Math.floor(+raw.quantity) : null,
  };

  const errors = {};
  if (d.name.length < 2) errors.name = "Enter your name.";
  if (d.company.length < 2) errors.company = "We supply businesses only, so we need a company name.";
  if (!EMAIL_RE.test(d.email)) errors.email = "Enter a valid email address.";
  if (!PHONE_RE.test(d.phone)) errors.phone = "Enter a valid phone number.";
  if (d.quantity !== null && d.quantity < MIN_QTY)
    errors.quantity = `Minimum order is ${MIN_QTY} pieces per style.`;
  // GSTIN is optional, but if supplied it must be well-formed or it is useless
  if (d.gstin && !GSTIN_RE.test(d.gstin)) errors.gstin = "That does not look like a valid GSTIN.";

  return { data: d, errors };
}

/* ── notifications ───────────────────────────────────────────────────────── */

async function sendEmail(env, { to, subject, html, replyTo }) {
  if (!env.RESEND_API_KEY) return { ok: false, skipped: "no RESEND_API_KEY" };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.FROM_EMAIL || "D. SANT <onboarding@resend.dev>",
      to: [to],
      subject: noCRLF(subject),
      html,
      ...(replyTo ? { reply_to: [replyTo] } : {}),
    }),
    signal: withTimeout(10000),
  });
  return { ok: res.ok, status: res.status, body: res.ok ? null : await res.text() };
}

async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID)
    return { ok: false, skipped: "not configured" };
  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: withTimeout(8000),
    }
  );
  return { ok: res.ok, status: res.status, body: res.ok ? null : await res.text() };
}

const row = (k, v) =>
  v ? `<tr><td style="padding:7px 18px 7px 0;color:#6b7075;white-space:nowrap;font-size:13px">${esc(k)}</td>
        <td style="padding:7px 0;color:#17191c;font-size:14px"><strong>${esc(v)}</strong></td></tr>` : "";

/* Digits only, so the owner can tap straight through to WhatsApp or a dial
   from the notification. "+91 98765 43210" is not a valid wa.me path. */
const digits = (s) => String(s || "").replace(/[^0-9]/g, "");

/* A UUID is unusable over the phone. This takes the first 6 hex characters
   and uppercases them - short enough to read aloud, and still unique enough
   at this volume to find the row. Derived, not stored, so it never has to
   be kept in sync with the id. */
const ref = (id) => "DS-" + String(id).replace(/-/g, "").slice(0, 6).toUpperCase();

/* IST. The Worker runs in UTC and a timestamp the reader has to mentally
   convert is worse than no timestamp. */
const istStamp = (iso) =>
  new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", day: "numeric", month: "short",
    hour: "numeric", minute: "2-digit", hour12: true,
  });

/* The commercial summary - what the enquiry is actually worth. Shown large
   because it is the one line that decides whether to reply now or later. */
const headline = (d) => {
  const parts = [];
  if (d.quantity) parts.push(`${d.quantity.toLocaleString("en-IN")} pcs`);
  if (d.product) parts.push(d.product);
  return parts.join(" · ") || "Quantity and product not specified";
};

const action = (href, label) =>
  `<a href="${href}" style="display:inline-block;padding:10px 16px;margin:0 8px 8px 0;
     background:#17191c;color:#f7f7f6;text-decoration:none;border-radius:6px;
     font-size:13px;font-weight:600">${esc(label)}</a>`;

function ownerEmailHtml(d, createdAt) {
  const wa = digits(d.phone);
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:600px;color:#17191c">
  <p style="margin:0;font:600 11px/1 ui-monospace,monospace;letter-spacing:.18em;color:#b8492a;text-transform:uppercase">New trade enquiry</p>

  <h2 style="margin:10px 0 2px;font-size:24px;line-height:1.2">${esc(d.company)}</h2>
  <p style="margin:0 0 4px;font-size:17px;color:#3f4347">${esc(headline(d))}</p>
  <p style="margin:0 0 22px;font-size:12px;color:#8a8f94">${esc(istStamp(createdAt))} IST${d.country ? " · " + esc(d.country) : ""} · Ref ${esc(d.ref)}</p>

  <div style="margin-bottom:22px">
    ${wa ? action("https://wa.me/" + wa, "WhatsApp " + d.name.split(" ")[0]) : ""}
    ${wa ? action("tel:" + d.phone.replace(/\s/g, ""), "Call") : ""}
    ${action("mailto:" + d.email, "Email")}
  </div>

  <table style="border-collapse:collapse;width:100%;border-top:1px solid #e4e4e2">
    ${row("Contact", d.name)}
    ${row("Phone", d.phone)}
    ${row("Email", d.email)}
    ${row("Buyer type", d.buyerType)}
    ${row("GSTIN", d.gstin)}
    ${row("Branding", d.branding)}
  </table>

  ${d.message ? `<p style="margin:22px 0 6px;color:#6b7075;font-size:12px;text-transform:uppercase;letter-spacing:.1em">What they said</p>
    <div style="white-space:pre-wrap;padding:14px 16px;background:#f7f7f6;border-left:3px solid #b8492a;
      border-radius:0 6px 6px 0;font-size:14px;line-height:1.6">${esc(d.message)}</div>` : ""}

  <p style="margin-top:26px;padding-top:16px;border-top:1px solid #e4e4e2;font-size:12px;color:#8a8f94">
    Replying to this email goes straight to ${esc(d.name)}.
  </p>
</div>`;
}

function customerEmailHtml(d) {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:600px;color:#17191c">
  <p style="margin:0;font:600 11px/1 ui-monospace,monospace;letter-spacing:.18em;color:#b8492a;text-transform:uppercase">D. Sant</p>
  <h2 style="margin:12px 0 14px;font-size:23px;line-height:1.25">Thanks — we have your enquiry.</h2>

  <p style="font-size:15px;line-height:1.65;color:#3f4347;margin:0 0 18px">
    Hi ${esc(d.name)}, we have your request${d.product ? ` for <strong>${esc(d.product)}</strong>` : ""}
    and will come back <strong>within one business day</strong> with trade pricing, fabric options
    and a realistic lead time.
  </p>

  <table style="border-collapse:collapse;width:100%;border-top:1px solid #e4e4e2">
    ${row("Reference", d.ref)}
    ${row("Company", d.company)}
    ${row("Quantity", d.quantity ? d.quantity.toLocaleString("en-IN") + " pcs" : "")}
    ${row("Branding", d.branding)}
  </table>

  <p style="font-size:13px;color:#6b7075;line-height:1.65;margin:20px 0">
    Nothing is confirmed yet — this only acknowledges that your enquiry reached us.
    If anything above is wrong, just reply to this email.
  </p>

  <p style="font-size:13px;line-height:1.8;color:#6b7075;margin:0;padding-top:16px;border-top:1px solid #e4e4e2">
    <strong style="color:#17191c">D. Sant</strong> · Unisex sportswear manufacturer<br>
    1450, Ground Floor Hall 1, Pooth Kalan, Rohini, Delhi 110086<br>
    <a href="tel:+917292002551" style="color:#b8492a">+91 72920 02551</a> ·
    <a href="mailto:sales.dsant@gmail.com" style="color:#b8492a">sales.dsant@gmail.com</a>
  </p>
</div>`;
}

/* ── handler ─────────────────────────────────────────────────────────────── */

export default {
  /* Retention sweep. The privacy policy commits to deleting enquiries after
     24 months; this is the thing that honours it. Runs daily, deletes in one
     statement, and logs the count so the job is auditable. */
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400 * 1000).toISOString();
    try {
      const res = await env.DB
        .prepare("DELETE FROM enquiries WHERE created_at < ?")
        .bind(cutoff)
        .run();
      console.log(`retention sweep: removed ${res.meta?.changes ?? 0} enquiries older than ${cutoff}`);
    } catch (err) {
      console.error("retention sweep failed", err);
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/enquiry") return env.ASSETS.fetch(request);
    if (request.method !== "POST")
      return json(405, { ok: false, error: "Method not allowed." });

    // Same-origin only. Not a security boundary on its own (a non-browser
    // client sets any Origin it likes) but it stops other sites posting here.
    const origin = request.headers.get("origin");
    if (origin && new URL(origin).host !== url.host)
      return json(403, { ok: false, error: "Cross-origin requests are not accepted." });

    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    if (await rateLimited(env, ip))
      return json(429, { ok: false, error: "Too many enquiries from this connection. Try again later." });

    /* Measured from the stream, not from Content-Length. That header is
       optional and attacker-supplied: omit it and a naive check reads 0,
       passes, and then buffers an unbounded body into memory. */
    const bodyText = await readCapped(request, MAX_BODY_BYTES);
    if (bodyText === null) return json(413, { ok: false, error: "Payload too large." });

    let raw;
    try {
      raw = JSON.parse(bodyText);
    } catch {
      return json(400, { ok: false, error: "Malformed request." });
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
      return json(400, { ok: false, error: "Malformed request." });

    /* Honeypot + time-to-fill. Both are silent: a bot that knows it failed
       adapts, so this returns the same success shape a real submission gets. */
    const trapped =
      str(raw.website, 200).length > 0 ||
      (Number.isFinite(+raw.elapsed) && +raw.elapsed < 2000);
    if (trapped) {
      const fakeId = crypto.randomUUID();
      return json(200, { ok: true, id: fakeId, ref: ref(fakeId) });
    }

    if (!(await turnstileOk(env, raw.turnstileToken, ip)))
      return json(403, { ok: false, error: "Could not verify that you are human. Please reload and try again." });

    const { data, errors } = validate(raw);
    if (Object.keys(errors).length) return json(422, { ok: false, errors });

    /* Checked after validation so a malformed address cannot burn a slot,
       and after the honeypot so bots never learn the limit exists. */
    if (await emailLimited(env, data.email))
      return json(429, { ok: false, error: "This email address has already sent several enquiries. Please email us directly." });

    const id = crypto.randomUUID();
    data.ref = ref(id);
    const createdAt = new Date().toISOString();
    const country = request.cf?.country || null;

    // Store first - see the note at the top of this file.
    if (env.DB) {
      try {
        await env.DB.prepare(
          `INSERT INTO enquiries
             (id, created_at, name, company, buyer_type, gstin, email, phone,
              product, quantity, branding, message, country)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
          .bind(
            id, createdAt, data.name, data.company, data.buyerType || null,
            data.gstin || null, data.email, data.phone, data.product || null,
            data.quantity, data.branding || null, data.message || null, country
          )
          .run();
      } catch (err) {
        console.error("d1 insert failed", err);
        return json(500, { ok: false, error: "Could not save your enquiry. Please email us instead." });
      }
    }

    /* Notifications run after the response is committed. The visitor should
       not wait on a third-party API, and a Resend outage must not read as a
       failed submission when the enquiry is already safely stored. */
    ctx.waitUntil(
      (async () => {
        /* Falls back to the public business address. OWNER_EMAIL set as a
           dashboard Text variable does not survive a deploy - wrangler
           replaces vars with whatever the config declares, and the config
           declares none - so it silently emptied and owner notifications
           stopped with no error recorded. Set it as a Secret instead;
           secrets are preserved. This default means a wipe degrades to the
           right inbox rather than to silence. */
        const owner = env.OWNER_EMAIL || "sales.dsant@gmail.com";
        const results = await Promise.allSettled([
          owner &&
            sendEmail(env, {
              to: owner,
              replyTo: data.email,
              /* Leads with the qualifying numbers so the inbox list is
                 triageable without opening anything. */
              subject:
                `[${data.ref}] ${data.company}` +
                (data.quantity ? ` — ${data.quantity.toLocaleString("en-IN")} pcs` : "") +
                (data.product ? ` ${data.product}` : ""),
              html: ownerEmailHtml(data, createdAt),
            }),
          sendEmail(env, {
            to: data.email,
            subject: `We have your enquiry (${data.ref}) — D. Sant`,
            html: customerEmailHtml(data),
          }),
          sendTelegram(
            env,
            `<b>${esc(data.company)}</b>\n` +
              `${esc(headline(data))}\n\n` +
              `${esc(data.name)}${data.buyerType ? " · " + esc(data.buyerType) : ""}\n` +
              `${esc(data.phone)}\n` +
              `${esc(data.email)}\n` +
              (data.branding ? `Branding: ${esc(data.branding)}\n` : "") +
              (data.message ? `\n<i>${esc(data.message.slice(0, 220))}</i>\n` : "") +
              (digits(data.phone)
                ? `\n<a href="https://wa.me/${digits(data.phone)}">Reply on WhatsApp</a>`
                : "")
          ),
        ]);

        const okAt = (i) => results[i]?.status === "fulfilled" && results[i].value?.ok;

        /* Record WHY a notification failed, not just that it did. Without
           this the only diagnosis is `wrangler tail`, which means an
           operator has to be watching at the moment it breaks. Truncated
           and stored on the row so it is visible next to the enquiry. */
        const why = (label, i) => {
          const r = results[i];
          if (!r) return null;
          if (r.status === "rejected") return `${label}: ${String(r.reason).slice(0, 120)}`;
          const v = r.value;
          if (!v || v.ok) return null;
          // not-configured is a deliberate state, not a delivery failure
          if (v.skipped) return null;
          return `${label}: HTTP ${v.status} ${String(v.body || "").slice(0, 200)}`;
        };
        const errors = [why("owner", 0), why("customer", 1), why("telegram", 2)]
          .filter(Boolean)
          .join(" | ")
          .slice(0, 500);

        if (env.DB) {
          await env.DB.prepare(
            `UPDATE enquiries SET owner_notified = ?, customer_notified = ?, notify_error = ? WHERE id = ?`
          )
            .bind(okAt(0) ? 1 : 0, okAt(1) ? 1 : 0, errors || null, id)
            .run()
            .catch(() => {});
        }
      })()
    );

    return json(200, { ok: true, id, ref: data.ref });
  },
};
