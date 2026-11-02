const API = (window.RECIPE_API || "").replace(/\/+$/, "") + "/api/recipes";
const app = document.getElementById("app");
let cache = null; // list of recipe summaries

// ---------- API ----------

function getPasscode() {
  try { return localStorage.getItem("recipe-passcode") || ""; } catch { return ""; }
}
function setPasscode(v) {
  try { localStorage.setItem("recipe-passcode", v); } catch {}
}

async function api(path = "", opts = {}, retried = false) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { "Content-Type": "application/json", "X-Passcode": getPasscode(), ...(opts.headers || {}) },
  });
  if (res.status === 401 && !retried) {
    const code = prompt("Enter the passcode to make changes:");
    if (code) {
      setPasscode(code);
      return api(path, opts, true);
    }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- routing ----------

window.addEventListener("hashchange", render);
render();

function render() {
  const m = location.hash.match(/^#\/r\/(.+)$/);
  window.scrollTo(0, 0);
  if (m) renderRecipe(decodeURIComponent(m[1]));
  else renderHome();
}

// ---------- home ----------

async function renderHome() {
  app.replaceChildren(document.getElementById("home-tpl").content.cloneNode(true));
  const form = document.getElementById("add-form");
  const input = document.getElementById("url");
  const status = document.getElementById("add-status");
  const search = document.getElementById("search");
  const grid = document.getElementById("grid");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    status.className = "status";
    status.textContent = "Fetching the recipe…";
    try {
      const { recipe, duplicate } = await api("", { method: "POST", body: JSON.stringify({ url: input.value }) });
      cache = null;
      if (duplicate) status.textContent = "Already saved — opening it.";
      location.hash = "#/r/" + encodeURIComponent(recipe.id);
    } catch (err) {
      status.className = "status error";
      status.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });

  search.addEventListener("input", () => drawGrid(grid, search.value));
  setupBookmarklet();

  // The bookmarklet import redirects here with ?error=… if something failed.
  const err = new URLSearchParams(location.hash.split("?")[1] || "").get("error");
  if (err) {
    status.className = "status error";
    status.textContent = err;
  }

  if (!cache) {
    grid.innerHTML = `<p class="muted">Loading…</p>`;
    try {
      cache = (await api()).recipes;
    } catch (err) {
      grid.innerHTML = `<p class="status error">Couldn't load recipes: ${esc(err.message)}</p>`;
      return;
    }
  }
  drawGrid(grid, "");
}

function drawGrid(grid, query) {
  const q = query.trim().toLowerCase();
  const list = cache.filter((r) => !q || (r.name + " " + r.site).toLowerCase().includes(q));
  if (!cache.length) {
    grid.innerHTML = `<p class="muted">No recipes yet. Paste a link above to save the first one.</p>`;
    return;
  }
  if (!list.length) {
    grid.innerHTML = `<p class="muted">Nothing matches “${esc(query)}”.</p>`;
    return;
  }
  grid.innerHTML = list
    .map(
      (r) => `
      <a class="card" href="#/r/${encodeURIComponent(r.id)}">
        <div class="thumb">${r.image ? `<img src="${esc(r.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}</div>
        <div class="card-body">
          <h3>${esc(r.name)}</h3>
          <p class="muted">${esc(r.site || "")}</p>
        </div>
      </a>`
    )
    .join("");
}

// ---------- bookmarklet ----------
// Runs on the recipe site in her own browser: collects the page's recipe data
// (JSON-LD) and form-posts it to the worker, which redirects back here.

function bookmarkletCode() {
  const importUrl = (window.RECIPE_API || "").replace(/\/+$/, "") + "/api/import";
  const src = `(()=>{
    const d=[...document.querySelectorAll('script[type="application/ld+json"]')]
      .map(s=>'<script type="application/ld+json">'+s.textContent+'</scr'+'ipt>').join('');
    if(!d){alert('No recipe found on this page.');return}
    const f=document.createElement('form');f.method='POST';f.action=${JSON.stringify(importUrl)};
    [['url',location.href],['data',d],['passcode',${JSON.stringify(getPasscode())}]].forEach(([k,v])=>{
      const i=document.createElement('input');i.type='hidden';i.name=k;i.value=v;f.appendChild(i)});
    document.body.appendChild(f);f.submit();
  })()`;
  return "javascript:" + encodeURIComponent(src.replace(/\n\s*/g, ""));
}

function setupBookmarklet() {
  const link = document.getElementById("bm-link");
  const copy = document.getElementById("bm-copy");
  link.href = bookmarkletCode();
  link.addEventListener("click", (e) => {
    e.preventDefault();
    alert("Drag this button to your bookmarks bar, then click it while viewing a recipe.");
  });
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(bookmarkletCode());
      copy.textContent = "Copied!";
    } catch {
      prompt("Copy this code:", bookmarkletCode());
    }
  });
}

// ---------- recipe ----------

async function renderRecipe(id) {
  app.innerHTML = `<p class="muted pad">Loading…</p>`;
  let r;
  try {
    r = (await api("/" + encodeURIComponent(id))).recipe;
  } catch (err) {
    app.innerHTML = `<div class="pad"><p class="status error">${esc(err.message)}</p><p><a href="#/">← Back to recipes</a></p></div>`;
    return;
  }

  const times = [
    ["Prep", r.prepTime],
    ["Cook", r.cookTime],
    ["Total", r.totalTime],
    ["Makes", r.yield],
  ].filter(([, v]) => v);

  document.title = r.name + " · Recipe Box";
  app.innerHTML = `
    <article class="recipe">
      <a href="#/" class="back no-print">← All recipes</a>
      <header class="recipe-head">
        ${r.image ? `<img class="hero" src="${esc(r.image)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
        <h1>${esc(r.name)}</h1>
        ${times.length ? `<dl class="meta">${times.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` : ""}
        <p class="muted">From <a href="${esc(r.source)}" target="_blank" rel="noopener">${esc(r.site)}</a></p>
      </header>

      <div class="cols">
        <section class="ingredients">
          <h2>Ingredients</h2>
          <ul>
            ${r.ingredients.map((i, n) => `<li><label><input type="checkbox" id="ing-${n}"><span>${esc(i)}</span></label></li>`).join("")}
          </ul>
        </section>

        <section class="steps">
          <h2>Instructions</h2>
          ${r.instructions
            .map(
              (s) => `
              ${s.section ? `<h3>${esc(s.section)}</h3>` : ""}
              <ol>${s.steps.map((t) => `<li>${esc(t)}</li>`).join("")}</ol>`
            )
            .join("")}
        </section>
      </div>

      <footer class="actions no-print">
        <button type="button" id="print">Print</button>
        <button type="button" id="delete" class="ghost">Delete</button>
      </footer>
    </article>`;

  // Tap a step to mark it done.
  app.querySelectorAll(".steps li").forEach((li) => li.addEventListener("click", () => li.classList.toggle("done")));
  document.getElementById("print").addEventListener("click", () => window.print());
  document.getElementById("delete").addEventListener("click", async () => {
    if (!confirm(`Delete “${r.name}”?`)) return;
    try {
      await api("/" + encodeURIComponent(id), { method: "DELETE" });
      cache = null;
      location.hash = "#/";
    } catch (err) {
      alert(err.message);
    }
  });
}

window.addEventListener("hashchange", () => {
  if (!location.hash.startsWith("#/r/")) document.title = "Recipe Box";
});

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
