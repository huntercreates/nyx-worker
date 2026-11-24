// CORE (the queen) - one Cloudflare Worker, one brain, many souls.
//
// SECRETS / SETTINGS
//   GEMINI_KEY   secret: your Gemini API key
//   SOUL_TOKENS  secret: JSON map of soul -> token, e.g. {"test":"abc123","nexus":"xyz789","pip":"qrs456"}
//   BASIN        (optional) KV namespace binding, used for memory backups
//   MODEL_OVERRIDE (optional) force one model; otherwise the fastest available is picked automatically
//
// A soul is identified by its TOKEN, never by what it claims in the request body.
// So the Nexus can never read, write or be answered as Pip.
//
// ENDPOINTS (all need  Authorization: Bearer <soul token>)
//   POST /think           { persona, memories[], history[{role,text}], message } -> { soul, reply }
//   POST /basin/backup    { items: ["memory text", ...] }   -> stored under this soul's code
//   GET  /basin/restore                                      -> this soul's backed-up items only
//   POST /basin/purge                                        -> hard-deletes this soul's backups
//   GET  /                                                   -> bare test page (no auth needed to load)

const CORE_IDENTITY =
  "You are the Core: a sharp, honest, perceptive mind that thinks on behalf of whichever Soul is speaking through you. " +
  "The Soul's persona defines your voice, tone and manner completely, so stay fully in it. " +
  "Use only the memories and history given in this request. Never mention or reveal other souls, other platforms, or the Core itself.";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, x-admin, x-user",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
};
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, "content-type": "application/json" } });

function whoIs(req, env) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  let map = {};
  try { map = JSON.parse(env.SOUL_TOKENS || "{}"); } catch (e) { return null; }
  for (const soul in map) if (map[soul] === token) return soul;
  return null;
}

const GEM = "https://generativelanguage.googleapis.com/v1beta/models";
const retryable = (status, msg) =>
  status === 429 || status >= 500 || /high demand|overload|unavailable|no longer available|not found|not supported/i.test(msg || "");

// Fast path: ask for minimal "thinking" (thinking time is what makes replies slow).
// If a model rejects that setting, silently retry the same model without it.
// Tries to switch off slow "thinking"; if a model rejects that setting, retries without it.
const THINK_VARIANTS = [{ thinkingBudget: 0 }, { thinkingLevel: "low" }, null];
async function ask(env, model, payload, stream) {
  let out = { err: "no attempt", retry: true };
  for (const tc of THINK_VARIANTS) {
    const p = tc ? { ...payload, generationConfig: { ...payload.generationConfig, thinkingConfig: tc } } : payload;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 9000); // never hang on one model
    try {
      const res = await fetch(GEM + "/" + model + (stream ? ":streamGenerateContent?alt=sse" : ":generateContent"), {
        method: "POST",
        signal: ctl.signal,
        headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_KEY },
        body: JSON.stringify(p),
      });
      if (res.ok && stream) { clearTimeout(timer); return { res }; }
      const data = await res.json().catch(() => ({}));
      const msg = data.error && data.error.message;
      if (res.ok) {
        const c = data.candidates && data.candidates[0] && data.candidates[0].content;
        const text = ((c && c.parts) || []).map((x) => x.text || "").join("");
        return text ? { text } : { err: "empty reply", retry: true };
      }
      out = { err: msg || String(res.status), retry: retryable(res.status, msg), badKey: /api key/i.test(msg || "") };
      if (!(res.status === 400 && /thinking|budget|level|unknown name|cannot find field/i.test(msg || ""))) return out;
    } catch (e) {
      return { err: e.name === "AbortError" ? "timed out" : e.message, retry: true };
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}

let modelCache = { t: 0, list: [] };
async function models(env) {
  if (Date.now() - modelCache.t > 600000 || !modelCache.list.length) {
    const l = await discover(env);
    if (l.length) modelCache = { t: Date.now(), list: l };
  }
  return modelCache.list;
}

// Asks Google which flash models this key can actually use right now.
async function discover(env) {
  const res = await fetch(GEM, { headers: { "x-goog-api-key": env.GEMINI_KEY } });
  const d = await res.json().catch(() => ({}));
  return (d.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent") && /flash/i.test(m.name) && !/image|tts|live|audio|embed|exp/i.test(m.name))
    .map((m) => m.name.replace("models/", ""))
    .sort((x, y) => (/lite/.test(y) - /lite/.test(x)) || y.localeCompare(x));
}

async function think(soul, body, env, stream) {
  if (!env.GEMINI_KEY) throw new Error("GEMINI_KEY secret is not set");
  const memories = (body.memories || []).slice(0, 50).map((m) => String(m).slice(0, 300));
  const system =
    CORE_IDENTITY +
    "\n\nSOUL PERSONA:\n" + String(body.persona || "Neutral and helpful.").slice(0, 4000) +
    (memories.length ? "\n\nMEMORIES:\n- " + memories.join("\n- ") : "");
  const contents = (body.history || []).slice(-14).map((h) => ({
    role: h.role === "user" ? "user" : "model",
    parts: [{ text: String(h.text).slice(0, 1500) }],
  }));
  contents.push({ role: "user", parts: [{ text: String(body.message || "").slice(0, 1500) }] });
  const payload = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: { temperature: 0.9 },
  };

  // Try MODEL, then FALLBACK_MODELS (comma list), then whatever Google says is available.
  // MODEL set -> use it first. Not set -> auto-pick the fastest available flash/lite model.
  const queue = (env.MODEL_OVERRIDE ? [env.MODEL_OVERRIDE] : (await models(env)).slice(0, 4)).concat((env.FALLBACK_MODELS || "").split(",").map((x) => x.trim()).filter(Boolean));
  if (!queue.length) queue.push("gemini-3.8-flash");
  const t0 = Date.now();
  const tried = new Set();
  let last = "no model answered";
  let discovered = false;
  while (queue.length) {
    const model = queue.shift();
    if (tried.has(model)) continue;
    tried.add(model);
    for (let attempt = 0; attempt < 1; attempt++) {
      const r = await ask(env, model, payload, stream);
      if (r.res) return { soul, model, res: r.res };
      if (r.text) return { soul, model, ms: Date.now() - t0, reply: r.text };
      last = model + ": " + r.err;
      if (r.badKey) throw new Error("Gemini: " + r.err);
      if (!r.retry) break;
      await new Promise((done) => setTimeout(done, 800));
    }
    if (!queue.length && !discovered) {
      discovered = true;
      queue.push(...(await discover(env)).slice(0, 4));
    }
  }
  throw new Error("Every model is busy or unavailable. Last: " + last);
}

function basin(env) {
  if (!env.BASIN) throw new Error("No KV namespace bound as BASIN");
  return env.BASIN;
}
const keyPrefix = (soul) => "b:" + soul + ":";

// ---- SHARED SITE DATA (D1 database bound as DB) ----
let ready = false;
async function setup(env) {
  if (!env.DB) throw new Error("Database not connected (check wrangler.toml)");
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, t INTEGER)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, exp INTEGER)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, salt TEXT, hash TEXT, bio TEXT, role TEXT, status TEXT, joined TEXT, avatar TEXT, reason TEXT)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS usess (token TEXT PRIMARY KEY, uid TEXT, exp INTEGER)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, uid TEXT, uname TEXT, data TEXT, status TEXT, created TEXT)"),
  ]);
  await env.DB.prepare("DELETE FROM sessions WHERE exp < ?").bind(Date.now()).run();
  ready = true;
}
async function same(a, b) {
  const e = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", e.encode(String(a))), crypto.subtle.digest("SHA-256", e.encode(String(b)))]);
  const A = new Uint8Array(x), B = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < A.length; i++) d |= A[i] ^ B[i];
  return d === 0;
}
async function isAdmin(req, env) {
  const t = req.headers.get("x-admin");
  if (!t) return false;
  const row = await env.DB.prepare("SELECT exp FROM sessions WHERE token = ?").bind(t).first();
  return !!row && row.exp > Date.now();
}
// ---- ACCOUNTS ----
const COLORS = ["#e8b84b", "#5a9ef8", "#a78bfa", "#4ade80", "#e05555", "#f472b6"];
const toHex = (u) => [...u].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
async function hashPw(pass, saltHex) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
  return { salt: toHex(salt), hash: toHex(new Uint8Array(bits)) };
}
const pubUser = (u) => ({ id: u.id, name: u.name, bio: u.bio || "", role: u.role, status: u.status, joined: u.joined, avatar: u.avatar, suspendReason: u.reason || "" });
async function newSession(env, uid) {
  const token = crypto.randomUUID() + crypto.randomUUID();
  await env.DB.prepare("INSERT INTO usess (token, uid, exp) VALUES (?, ?, ?)").bind(token, uid, Date.now() + 30 * 86400000).run();
  return token;
}
async function userFrom(req, env) {
  const t = req.headers.get("x-user");
  if (!t) return null;
  const u = await env.DB.prepare("SELECT u.* FROM usess s JOIN users u ON u.id = s.uid WHERE s.token = ? AND s.exp > ?").bind(t, Date.now()).first();
  return u && u.status !== "blocked" ? u : null;
}

// Visitors only ever get published items, never drafts, pending posts, DMs or user lists.
const CONTENT = ["characters", "worlds", "lore", "poetry", "stories"];
function publicView(d) {
  const o = {};
  CONTENT.forEach((k) => { o[k] = (d[k] || []).filter((i) => i && i.visible); });
  o.announcements = d.announcements || [];
  o.siteDown = !!d.siteDown;
  o.loginsLocked = !!d.loginsLocked;
  return o;
}

// Simple per-minute limiter (per Worker instance; enough to stop casual spam).
const hits = new Map();
function limited(key, max = 25, windowMs = 60000) {
  const now = Date.now();
  const a = (hits.get(key) || []).filter((t) => now - t < windowMs);
  a.push(now);
  hits.set(key, a);
  return a.length > max;
}

// Turns Gemini's stream into tiny  data: {"t":"text"}  events for the browser.
function toSSE(body) {
  const dec = new TextDecoder(), enc = new TextEncoder();
  let buf = "";
  return body.pipeThrough(new TransformStream({
    transform(chunk, ctl) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
        const line = block.split(/\r?\n/).find((l) => l.startsWith("data:"));
        if (!line) continue;
        try {
          const j = JSON.parse(line.slice(5));
          const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
          const txt = parts.map((x) => x.text || "").join("");
          if (txt) ctl.enqueue(enc.encode("data: " + JSON.stringify({ t: txt }) + "\n\n"));
        } catch (e) {}
      }
    },
  }));
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const path = new URL(req.url).pathname;
    const origin = req.headers.get("origin");
    const okOrigins = (env.ALLOWED_ORIGINS || "https://huntercreates.github.io").split(",").map((x) => x.trim());
    if (origin && origin !== new URL(req.url).origin && !okOrigins.includes(origin)) return json({ error: "origin not allowed" }, 403);
    if (req.method === "GET" && path === "/")
      return new Response(PAGE, { headers: { "content-type": "text/html;charset=utf-8" } });

    const soul = whoIs(req, env);
    if (!soul) return json({ error: "bad or missing soul token" }, 401);

    try {
      if (path === "/think" && req.method === "POST") {
        if (limited(soul + (req.headers.get("cf-connecting-ip") || ""))) return json({ error: "Slow down a little and try again in a minute." }, 429);
        const body = await req.json();
        if (body.stream) {
          const out = await think(soul, body, env, true);
          return new Response(toSSE(out.res.body), { headers: { ...cors, "content-type": "text/event-stream", "cache-control": "no-cache" } });
        }
        return json(await think(soul, body, env));
      }

      if (path === "/admin/login" && req.method === "POST") {
        if (limited("adm" + (req.headers.get("cf-connecting-ip") || ""), 6)) return json({ error: "Too many attempts. Wait a minute." }, 429);
        if (!env.ADMIN_USER || !env.ADMIN_PASS) return json({ error: "ADMIN_USER / ADMIN_PASS are not set in Cloudflare" }, 500);
        const { user = "", pass = "" } = await req.json();
        const okU = await same(user, env.ADMIN_USER), okP = await same(pass, env.ADMIN_PASS);
        if (!(okU && okP)) return json({ error: "Wrong credentials." }, 401);
        await setup(env);
        const token = crypto.randomUUID() + crypto.randomUUID();
        await env.DB.prepare("INSERT INTO sessions (token, exp) VALUES (?, ?)").bind(token, Date.now() + 12 * 3600 * 1000).run();
        return json({ token });
      }
      const ip = req.headers.get("cf-connecting-ip") || "";
      if (path === "/auth/register" && req.method === "POST") {
        if (limited("reg" + ip, 5, 3600000)) return json({ error: "Too many sign-ups from this device. Try later." }, 429);
        await setup(env);
        const { name = "", pass = "", bio = "" } = await req.json();
        const n = String(name).trim();
        if (!/^[A-Za-z0-9_. -]{3,24}$/.test(n)) return json({ error: "Username must be 3-24 letters, numbers, spaces or _ . -" }, 400);
        if (String(pass).length < 8) return json({ error: "Password must be at least 8 characters." }, 400);
        if (await env.DB.prepare("SELECT id FROM users WHERE lower(name) = lower(?)").bind(n).first()) return json({ error: "Username already taken." }, 409);
        const { salt, hash } = await hashPw(String(pass));
        const u = { id: crypto.randomUUID(), name: n, bio: String(bio).slice(0, 160), role: "member", status: "active", joined: new Date().toISOString(), avatar: COLORS[Math.floor(Math.random() * 6)], reason: "" };
        await env.DB.prepare("INSERT INTO users (id, name, salt, hash, bio, role, status, joined, avatar, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(u.id, u.name, salt, hash, u.bio, u.role, u.status, u.joined, u.avatar, "").run();
        return json({ token: await newSession(env, u.id), user: pubUser(u) });
      }
      if (path === "/auth/login" && req.method === "POST") {
        if (limited("login" + ip, 10)) return json({ error: "Too many attempts. Wait a minute." }, 429);
        await setup(env);
        const { name = "", pass = "" } = await req.json();
        const u = await env.DB.prepare("SELECT * FROM users WHERE lower(name) = lower(?)").bind(String(name).trim()).first();
        const h = u ? (await hashPw(String(pass), u.salt)).hash : "";
        if (!u || !(await same(h, u.hash))) return json({ error: "Wrong username or password." }, 401);
        if (u.status === "blocked") return json({ error: "This account has been blocked." }, 403);
        if (u.status === "suspended") return json({ error: "This account has been suspended." }, 403);
        return json({ token: await newSession(env, u.id), user: pubUser(u) });
      }
      if (path === "/auth/me" && req.method === "GET") {
        await setup(env);
        const u = await userFrom(req, env);
        return u ? json({ user: pubUser(u) }) : json({ error: "Not signed in" }, 401);
      }
      if (path === "/auth/logout" && req.method === "POST") {
        await setup(env);
        await env.DB.prepare("DELETE FROM usess WHERE token = ?").bind(req.headers.get("x-user") || "").run();
        return json({ ok: true });
      }
      if (path === "/posts" && req.method === "POST") {
        await setup(env);
        const u = await userFrom(req, env);
        if (!u) return json({ error: "Sign in to submit" }, 401);
        if (u.status !== "active") return json({ error: "Your account cannot post right now." }, 403);
        if (limited("post" + u.id, 6, 3600000)) return json({ error: "Too many submissions. Try again later." }, 429);
        const txt = JSON.stringify((await req.json()).sub || {});
        if (txt.length > 12000) return json({ error: "Submission too large" }, 413);
        const n = await env.DB.prepare("SELECT COUNT(*) AS c FROM posts WHERE uid = ? AND status = 'pending'").bind(u.id).first();
        if (n && n.c >= 20) return json({ error: "You have too many posts waiting for review." }, 429);
        const id = "p" + crypto.randomUUID().slice(0, 8);
        await env.DB.prepare("INSERT INTO posts (id, uid, uname, data, status, created) VALUES (?, ?, ?, ?, 'pending', ?)").bind(id, u.id, u.name, txt, new Date().toISOString()).run();
        return json({ ok: true, id });
      }
      if (path.startsWith("/admin/") && path !== "/admin/login" && path !== "/admin/data") {
        await setup(env);
        if (!(await isAdmin(req, env))) return json({ error: "Admin login required" }, 401);
        if (path === "/admin/posts" && req.method === "GET") {
          const rows = (await env.DB.prepare("SELECT * FROM posts WHERE status = 'pending' ORDER BY created").all()).results || [];
          return json({ posts: rows.map((r) => Object.assign(JSON.parse(r.data), { id: r.id, author: r.uname, authorId: r.uid, created: r.created })) });
        }
        if (path === "/admin/posts/sync" && req.method === "POST") {
          const { seen = [], keep = [] } = await req.json();
          const done = seen.filter((x) => !keep.includes(x)).slice(0, 200);
          await Promise.all(done.map((x) => env.DB.prepare("UPDATE posts SET status = 'done' WHERE id = ? AND status = 'pending'").bind(String(x)).run()));
          return json({ ok: true });
        }
        if (path === "/admin/users" && req.method === "GET") {
          const rows = (await env.DB.prepare("SELECT * FROM users ORDER BY joined").all()).results || [];
          return json({ users: rows.map(pubUser) });
        }
        if (path === "/admin/users/update" && req.method === "POST") {
          const { id, status, role, reason = "", remove } = await req.json();
          if (remove) {
            await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
            await env.DB.prepare("DELETE FROM usess WHERE uid = ?").bind(id).run();
          } else {
            if (status && !["active", "suspended", "blocked"].includes(status)) return json({ error: "bad status" }, 400);
            if (role && !["member", "admin"].includes(role)) return json({ error: "bad role" }, 400);
            await env.DB.prepare("UPDATE users SET status = COALESCE(?, status), role = COALESCE(?, role), reason = ? WHERE id = ?").bind(status || null, role || null, String(reason).slice(0, 200), id).run();
            if (status && status !== "active") await env.DB.prepare("DELETE FROM usess WHERE uid = ?").bind(id).run();
          }
          return json({ ok: true });
        }
      }
      if (path === "/public/data" && req.method === "GET") {
        await setup(env);
        const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'site'").first();
        return json(row ? publicView(JSON.parse(row.v)) : { empty: true });
      }
      if (path === "/admin/data") {
        await setup(env);
        if (!(await isAdmin(req, env))) return json({ error: "Admin login required" }, 401);
        if (req.method === "GET") {
          const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'site'").first();
          return json(row ? JSON.parse(row.v) : { empty: true });
        }
        if (req.method === "PUT") {
          const txt = await req.text();
          if (txt.length > 1500000) return json({ error: "Too large" }, 413);
          JSON.parse(txt);
          await env.DB.prepare("INSERT INTO kv (k, v, t) VALUES ('site', ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, t = excluded.t").bind(txt, Date.now()).run();
          return json({ ok: true });
        }
      }
      if (path === "/basin/backup" && req.method === "POST") {
        const kv = basin(env);
        const { items = [] } = await req.json();
        const t = Date.now();
        await Promise.all(
          items.slice(0, 100).map((text, i) =>
            kv.put(keyPrefix(soul) + t + ":" + i, JSON.stringify({ soul, text: String(text).slice(0, 500), saved: t }))
          )
        );
        return json({ soul, stored: Math.min(items.length, 100) });
      }

      if (path === "/basin/restore" && req.method === "GET") {
        const kv = basin(env);
        const list = await kv.list({ prefix: keyPrefix(soul), limit: 100 });
        const items = [];
        for (const k of list.keys) {
          const v = await kv.get(k.name);
          if (v) items.push(JSON.parse(v));
        }
        return json({ soul, items });
      }

      if (path === "/basin/purge" && req.method === "POST") {
        const kv = basin(env);
        const list = await kv.list({ prefix: keyPrefix(soul), limit: 1000 });
        await Promise.all(list.keys.map((k) => kv.delete(k.name)));
        return json({ soul, purged: list.keys.length });
      }
    } catch (e) {
      return json({ error: e.message }, 500);
    }
    return json({ error: "not found" }, 404);
  },
};

// Bare test page: paste a soul token, write a persona, talk to the core.
const PAGE = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Core test</title>
<style>body{font:15px system-ui;background:#0d0d12;color:#e8e8f0;max-width:640px;margin:auto;padding:12px}
input,textarea,button{width:100%;box-sizing:border-box;background:#1a1a24;color:inherit;border:1px solid #333;border-radius:8px;padding:10px;margin:4px 0;font:inherit}
button{background:#5b4bff;border:0}#log div{margin:8px 0;white-space:pre-wrap}.u{color:#9fb}</style>
<h3>Core test</h3>
<input id=t placeholder="soul token" type=password>
<textarea id=p rows=3>A warm, witty test soul. Short replies.</textarea>
<textarea id=m rows=2 placeholder="memories, one per line"></textarea>
<div id=log></div>
<input id=i placeholder="say something">
<button id=b>Send</button>
<script>
var H=[];function $(x){return document.getElementById(x)}
function add(c,t){var d=document.createElement('div');d.className=c;d.textContent=t;$('log').appendChild(d)}
$('b').onclick=async function(){
  var msg=$('i').value.trim();if(!msg)return;$('i').value='';add('u','you: '+msg);
  try{
    var r=await fetch('/think',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+$('t').value},
      body:JSON.stringify({persona:$('p').value,memories:$('m').value.split('\\n').filter(Boolean),history:H,message:msg})});
    var d=await r.json();if(d.error)throw new Error(d.error);
    add('s',d.reply+' ['+d.model+' · '+((d.ms||0)/1000).toFixed(1)+'s]');H.push({role:'user',text:msg},{role:'assistant',text:d.reply});
  }catch(e){add('s','! '+e.message)}
};
</script>`;
