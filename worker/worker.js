// Recipe Box API — Cloudflare Worker
//
// Routes:
//   GET    /api/recipes        list saved recipes (summary only)
//   GET    /api/recipes/:id    one full recipe
//   POST   /api/recipes        { url } -> fetch page, extract recipe, save it
//   PATCH  /api/recipes/:id    { made?, rating? } -> update status / stars
//   DELETE /api/recipes/:id    remove a recipe
//   POST   /api/import         form post from the bookmarklet (url, data)
//
// Bindings (set in wrangler.toml or the Cloudflare dashboard):
//   RECIPES          KV namespace (required)
//   SITE_URL         e.g. https://yourname.github.io/recipe-box  (where the bookmarklet returns to)
//   ALLOWED_ORIGIN   e.g. https://yourname.github.io  (optional, defaults to *)

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      // Copy so headers are mutable (Response.redirect's aren't).
      const original = await route(request, env);
      const res = new Response(original.body, original);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (err) {
      const status = err.status || 500;
      return json({ error: err.message || "Something went wrong" }, status, cors);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean); // ["api","recipes",id?]
  if (url.pathname === "/api/import" && request.method === "POST") return importRecipe(request, env);
  if (parts[0] !== "api" || parts[1] !== "recipes" || parts.length > 3) throw httpError(404, "Not found");
  const id = parts[2];

  if (request.method === "GET" && !id) return listRecipes(env);
  if (request.method === "GET" && id) return getRecipe(env, id);
  if (request.method === "POST" && !id) return addRecipe(request, env);
  if (request.method === "PATCH" && id) return updateRecipe(request, env, id);
  if (request.method === "DELETE" && id) return deleteRecipe(env, id);
  throw httpError(405, "Method not allowed");
}

// ---------- handlers ----------

async function listRecipes(env) {
  const recipes = [];
  let cursor;
  do {
    const page = await env.RECIPES.list({ prefix: "r:", cursor });
    for (const k of page.keys) recipes.push({ id: k.name.slice(2), ...(k.metadata || {}) });
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return json({ recipes });
}

async function getRecipe(env, id) {
  const recipe = await env.RECIPES.get("r:" + id, "json");
  if (!recipe) throw httpError(404, "Recipe not found");
  return json({ recipe });
}

async function addRecipe(request, env) {
  const body = await request.json().catch(() => ({}));
  const target = normalizeUrl(body.url);

  const existing = await findExisting(env, target);
  if (existing) return json({ recipe: existing, duplicate: true });

  const html = await fetchPage(target);
  const recipe = await saveRecipe(env, target, html);
  return json({ recipe }, 201);
}

// Called by the "Save to Recipe Box" bookmarklet as a plain form POST from the
// recipe page itself, for sites that block requests from servers. The
// bookmarklet sends the page's JSON-LD (read in the user's own browser), and
// we redirect back to the site.
async function importRecipe(request, env) {
  const site = (env.SITE_URL || "").replace(/\/+$/, "");
  try {
    const form = await request.formData();
    const target = normalizeUrl(form.get("url"));
    const recipe = (await findExisting(env, target)) || (await saveRecipe(env, target, String(form.get("data") || "")));
    if (!site) return json({ recipe });
    return Response.redirect(`${site}/#/r/${encodeURIComponent(recipe.id)}`, 303);
  } catch (err) {
    const msg = err.message || "Something went wrong";
    if (!site) return json({ error: msg }, err.status || 500);
    return Response.redirect(`${site}/#/?error=${encodeURIComponent(msg)}`, 303);
  }
}

async function findExisting(env, target) {
  const id = await env.RECIPES.get("u:" + target);
  return id ? env.RECIPES.get("r:" + id, "json") : null;
}

async function saveRecipe(env, target, html) {
  const recipe = extractRecipe(html, target);
  if (!recipe) {
    throw httpError(422, "Couldn't find a recipe on that page. Some sites don't publish their recipe in a readable format.");
  }

  // Reverse timestamp so KV's alphabetical listing comes back newest first.
  const id = String(9999999999999 - Date.now()).padStart(13, "0") + "-" + Math.random().toString(36).slice(2, 7);
  recipe.id = id;
  recipe.addedAt = new Date().toISOString();
  recipe.made = false;
  recipe.rating = 0;

  await putRecipe(env, recipe);
  await env.RECIPES.put("u:" + target, id);
  return recipe;
}

async function updateRecipe(request, env, id) {
  const recipe = await env.RECIPES.get("r:" + id, "json");
  if (!recipe) throw httpError(404, "Recipe not found");
  const body = await request.json().catch(() => ({}));
  if (typeof body.made === "boolean") recipe.made = body.made;
  if (body.rating !== undefined) {
    const r = Number(body.rating);
    if (!Number.isInteger(r) || r < 0 || r > 5) throw httpError(400, "Rating must be 0-5.");
    recipe.rating = r;
  }
  await putRecipe(env, recipe);
  return json({ recipe });
}

// The list view reads only KV metadata (max 1024 bytes), so keep a summary there.
async function putRecipe(env, recipe) {
  const metadata = {
    name: recipe.name.slice(0, 120),
    image: recipe.image || "",
    site: recipe.site,
    addedAt: recipe.addedAt,
    made: !!recipe.made,
    rating: recipe.rating || 0,
  };
  if (new TextEncoder().encode(JSON.stringify(metadata)).length > 1000) metadata.image = "";
  await env.RECIPES.put("r:" + recipe.id, JSON.stringify(recipe), { metadata });
}

async function deleteRecipe(env, id) {
  const recipe = await env.RECIPES.get("r:" + id, "json");
  if (!recipe) throw httpError(404, "Recipe not found");
  await env.RECIPES.delete("r:" + id);
  if (recipe.source) await env.RECIPES.delete("u:" + recipe.source);
  return json({ ok: true });
}

// ---------- fetching ----------

function normalizeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || "").trim());
  } catch {
    throw httpError(400, "That doesn't look like a link.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw httpError(400, "Only http(s) links are supported.");
  u.hash = "";
  // Drop tracking params so the same recipe isn't saved twice.
  for (const key of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|mc_|ref$|s$)/i.test(key)) u.searchParams.delete(key);
  }
  return u.toString();
}

async function fetchPage(target) {
  let res;
  try {
    res = await fetch(target, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      cf: { cacheTtl: 3600 },
    });
  } catch {
    throw httpError(502, "Couldn't reach that website.");
  }
  if (!res.ok) {
    throw httpError(
      502,
      `That site won't let us grab its recipes directly (HTTP ${res.status}).`
    );
  }
  return res.text();
}

// ---------- extraction ----------
// Nearly every recipe site embeds a schema.org "Recipe" object as JSON-LD for
// Google. We read that instead of scraping the page, which skips the ads,
// life story and pop-ups entirely.

export function extractRecipe(html, sourceUrl) {
  const node = findRecipeNode(html);
  if (!node) return null;

  const ingredients = toArray(node.recipeIngredient || node.ingredients).map(cleanIngredient).filter(Boolean);
  const instructions = parseInstructions(node.recipeInstructions);
  if (!ingredients.length && !instructions.length) return null;

  return {
    name: cleanText(node.name) || "Untitled recipe",
    description: cleanText(node.description),
    image: pickImage(node.image),
    yield: cleanText(toArray(node.recipeYield).find((y) => /\D/.test(String(y))) || toArray(node.recipeYield)[0]),
    prepTime: formatDuration(node.prepTime),
    cookTime: formatDuration(node.cookTime),
    totalTime: formatDuration(node.totalTime),
    ingredients,
    instructions, // [{ section: string|null, steps: [string] }]
    source: sourceUrl,
    site: new URL(sourceUrl).hostname.replace(/^www\./, ""),
  };
}

function findRecipeNode(html) {
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try {
      data = JSON.parse(m[1].trim().replace(/^<!--|-->$/g, ""));
    } catch {
      try {
        // Some sites put raw newlines/tabs inside strings.
        data = JSON.parse(m[1].replace(/[\u0000-\u001F]+/g, " "));
      } catch {
        continue;
      }
    }
    const found = walkForRecipe(data);
    if (found) return found;
  }
  return null;
}

function walkForRecipe(data, depth = 0) {
  if (!data || typeof data !== "object" || depth > 6) return null;
  if (Array.isArray(data)) {
    for (const item of data) {
      const f = walkForRecipe(item, depth + 1);
      if (f) return f;
    }
    return null;
  }
  const types = toArray(data["@type"]).map(String);
  if (types.some((t) => t.toLowerCase() === "recipe")) return data;
  for (const key of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "item"]) {
    const f = walkForRecipe(data[key], depth + 1);
    if (f) return f;
  }
  return null;
}

function parseInstructions(raw) {
  const sections = [];
  let loose = [];
  const flush = () => {
    if (loose.length) sections.push({ section: null, steps: loose });
    loose = [];
  };

  const visit = (item, into) => {
    if (item == null) return;
    if (typeof item === "string") {
      // A single blob of text: split on line breaks / <p> / <li>.
      const parts = item
        .split(/<\/?(?:p|li|br)\b[^>]*>|\r?\n+/i)
        .map(cleanText)
        .filter(Boolean);
      into.push(...parts);
      return;
    }
    if (Array.isArray(item)) return item.forEach((i) => visit(i, into));
    if (item.itemListElement) return visit(item.itemListElement, into);
    const text = cleanText(item.text || item.name || item.description);
    if (text) into.push(text);
  };

  // Top level: plain steps, or HowToSection groups ("For the sauce", ...).
  for (const item of toArray(raw).flat()) {
    if (item && typeof item === "object" && toArray(item["@type"]).map(String).includes("HowToSection")) {
      flush();
      const steps = [];
      visit(item.itemListElement || item.steps, steps);
      if (steps.length) sections.push({ section: cleanText(item.name) || null, steps });
    } else {
      visit(item, loose);
    }
  }
  flush();
  return sections;
}

function pickImage(img) {
  const first = toArray(img)[0];
  if (!first) return "";
  if (typeof first === "string") return first;
  return first.url || first.contentUrl || "";
}

function formatDuration(iso) {
  if (!iso || typeof iso !== "string") return "";
  const m = iso.match(/^P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:\d+(?:\.\d+)?S)?)?$/i);
  if (!m) return cleanText(iso);
  let mins = (+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0);
  mins = Math.round(mins);
  if (!mins) return "";
  const h = Math.floor(mins / 60);
  const rest = mins % 60;
  return [h ? `${h} hr` : "", rest ? `${rest} min` : ""].filter(Boolean).join(" ");
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", frac12: "½", frac14: "¼", frac34: "¾", deg: "°", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (all, code) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}

function cleanText(v) {
  if (v == null) return "";
  let s = String(v);
  // Decode twice: some sites double-encode (&amp;#39;).
  s = decodeEntities(decodeEntities(s));
  s = s.replace(/<[^>]*>/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

// Recipe plugins often glue fields together as "4 onions (, sliced) ((Note 2))".
function cleanIngredient(v) {
  let s = cleanText(v);
  for (let i = 0; i < 3; i++) {
    s = s
      .replace(/\(\s*\(([^()]*)\)\s*\)/g, "($1)") // ((x)) -> (x)
      .replace(/\(\s*(?:see\s+)?notes?\s*\d*\s*\)/gi, "") // (Note 2) — notes aren't kept
      .replace(/\(\s*[,;]\s*/g, "(") // (, sliced -> (sliced
      .replace(/\(\s*\)/g, "");
  }
  return s.replace(/\s+([,.;)])/g, "$1").replace(/\s{2,}/g, " ").replace(/[\s,]+$/, "").trim();
}

function toArray(v) {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

// ---------- helpers ----------

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
