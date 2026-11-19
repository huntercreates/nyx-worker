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
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
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
