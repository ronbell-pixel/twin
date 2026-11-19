// Twin Chimneys announcements API (Cloudflare Worker + KV).
//
// Public:  GET  /announcements            -> current announcements (not expired)
// Admin:   POST /login {password}         -> {token, expires}
//          GET  /admin/announcements      -> all announcements, including expired
//          POST /admin/announcements      -> create
//          PUT  /admin/announcements/:id  -> update
//          DELETE /admin/announcements/:id
//
// Secrets (set with `wrangler secret put`): ADMIN_PASSWORD, SESSION_SECRET.
// Changing ADMIN_PASSWORD signs every admin out.

const STORE_KEY = "announcements";
const MAX_ITEMS = 50;
const MAX_LINKS = 5;
const TOKEN_TTL_SECONDS = 8 * 60 * 60;
const MAX_FAILED_LOGINS = 8;
const FAILED_LOGIN_WINDOW_SECONDS = 15 * 60;
const TIME_ZONE = "America/Chicago";

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (path === "/announcements" && request.method === "GET") {
        const today = todayString();
        const items = (await readAll(env)).filter((a) => !a.expires || a.expires >= today);
        return json({ items }, 200, cors);
      }

      if (path === "/login" && request.method === "POST") {
        return await login(request, env, cors);
      }

      if (path === "/admin/announcements" || path.startsWith("/admin/announcements/")) {
        if (!(await isAuthorized(request, env))) return json({ error: "Please sign in again." }, 401, cors);
        const id = path.split("/")[3];

        if (!id && request.method === "GET") return json({ items: await readAll(env) }, 200, cors);

        if (!id && request.method === "POST") {
          const input = validate(await readJson(request));
          if (input.error) return json({ error: input.error }, 400, cors);
          const items = await readAll(env);
          if (items.length >= MAX_ITEMS) return json({ error: `Limit of ${MAX_ITEMS} announcements reached. Delete an old one first.` }, 400, cors);
          const now = new Date().toISOString();
          const item = { id: crypto.randomUUID(), ...input.value, created: now, updated: now };
          items.unshift(item);
          await writeAll(env, items);
          return json({ item }, 201, cors);
        }

        if (id && (request.method === "PUT" || request.method === "DELETE")) {
          const items = await readAll(env);
          const index = items.findIndex((a) => a.id === id);
          if (index === -1) return json({ error: "That announcement no longer exists." }, 404, cors);

          if (request.method === "DELETE") {
            items.splice(index, 1);
            await writeAll(env, items);
            return json({ ok: true }, 200, cors);
          }

          const input = validate(await readJson(request));
          if (input.error) return json({ error: input.error }, 400, cors);
          items[index] = { ...items[index], ...input.value, updated: new Date().toISOString() };
          await writeAll(env, items);
          return json({ item: items[index] }, 200, cors);
        }
      }

      return json({ error: "Not found" }, 404, cors);
    } catch (err) {
      console.error(err);
      return json({ error: "Something went wrong. Please try again." }, 500, cors);
    }
  },
};

// ---------- auth ----------

async function login(request, env, cors) {
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) {
    return json({ error: "Admin login is not configured yet." }, 503, cors);
  }
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const failKey = `failed-login:${ip}`;
  const failures = Number((await env.ANNOUNCEMENTS.get(failKey)) || 0);
  if (failures >= MAX_FAILED_LOGINS) {
    return json({ error: "Too many attempts. Please wait 15 minutes and try again." }, 429, cors);
  }

  const body = await readJson(request);
  const password = typeof body.password === "string" ? body.password : "";
  if (!(await safeEqual(password, env.ADMIN_PASSWORD, env.SESSION_SECRET))) {
    await env.ANNOUNCEMENTS.put(failKey, String(failures + 1), { expirationTtl: FAILED_LOGIN_WINDOW_SECONDS });
    return json({ error: "Incorrect password." }, 401, cors);
  }

  await env.ANNOUNCEMENTS.delete(failKey);
  const expires = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ exp: expires })));
  const signature = await sign(payload, env);
  return json({ token: `${payload}.${signature}`, expires: expires * 1000 }, 200, cors);
}

async function isAuthorized(request, env) {
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) return false;
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  if (!(await safeEqual(signature, await sign(payload, env), env.SESSION_SECRET))) return false;
  try {
    const { exp } = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    return typeof exp === "number" && exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

async function hmac(keyText, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(keyText), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

// Signing key includes the password, so changing the password invalidates old tokens.
async function sign(payload, env) {
  return b64url(await hmac(`${env.SESSION_SECRET}|${env.ADMIN_PASSWORD}`, payload));
}

// Compare two strings without leaking timing: compare their HMACs.
async function safeEqual(a, b, secret) {
  const [x, y] = await Promise.all([hmac(secret, a), hmac(secret, b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ---------- data ----------

async function readAll(env) {
  const raw = await env.ANNOUNCEMENTS.get(STORE_KEY);
  if (!raw) return [];
  try {
    const items = JSON.parse(raw);
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

async function writeAll(env, items) {
  await env.ANNOUNCEMENTS.put(STORE_KEY, JSON.stringify(items));
}

function validate(body) {
  const clean = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const title = clean(body.title, 120);
  const message = clean(body.message, 3000);
  const expires = clean(body.expires, 10);

  if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) return { error: "“Show until” must be a valid date." };

  const links = [];
  for (const link of Array.isArray(body.links) ? body.links.slice(0, MAX_LINKS) : []) {
    const label = clean(link && link.label, 80);
    const rawUrl = clean(link && link.url, 600);
    if (!label && !rawUrl) continue;
    const url = normalizeUrl(rawUrl);
    if (!url) return { error: `“${rawUrl || label}” is not a valid web address. Use https://…, an email address, or a phone number.` };
    links.push({ label: label || rawUrl, url });
  }

  if (!title && !message && links.length === 0) return { error: "Add a title, a message or at least one link." };
  return { value: { title, message, links, expires } };
}

function normalizeUrl(value) {
  if (!value) return "";
  let candidate = value;
  if (/^[^\s@/:]+@[^\s@/]+\.[^\s@/]+$/.test(candidate)) candidate = `mailto:${candidate}`;
  else if (/^\+?[\d\s().-]{7,}$/.test(candidate)) candidate = `tel:${candidate.replace(/[^\d+]/g, "")}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) candidate = `https://${candidate}`;
  try {
    const parsed = new URL(candidate);
    return ["https:", "http:", "mailto:", "tel:"].includes(parsed.protocol) ? parsed.href : "";
  } catch {
    return "";
  }
}

// ---------- helpers ----------

function todayString() {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (allowed.includes(origin) || isLocal) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(data, status, cors, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors, ...extra },
  });
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text) {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
