const API_BASE = (window.RECIPE_API || "").replace(/\/+$/, "");
const API = API_BASE + "/api/recipes";
const app = document.getElementById("app");
let cache = null; // list of recipe summaries
const view = { filter: load("filter", "all"), sort: load("sort", "new"), query: "" };

// ---------- API ----------

async function api(path = "", opts = {}) {
  const res = await fetch(API + path, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function updateRecipe(id, changes) {
  const { recipe } = await api("/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify(changes) });
  const summary = cache && cache.find((r) => r.id === id);
  if (summary) Object.assign(summary, { made: recipe.made, rating: recipe.rating });
  return recipe;
}

function load(key, fallback) {
  try { return localStorage.getItem("rb-" + key) || fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem("rb-" + key, value); } catch {}
}

// ---------- add form (lives in the header) ----------

const form = document.getElementById("add-form");
const input = document.getElementById("url");
const status = document.getElementById("add-status");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  button.textContent = "Adding…";
  setStatus("");
  try {
    const { recipe, duplicate } = await api("", { method: "POST", body: JSON.stringify({ url: input.value }) });
    cache = null;
    input.value = "";
    if (duplicate) setStatus("Already in the box — here it is!");
    location.hash = "#/r/" + encodeURIComponent(recipe.id);
  } catch (err) {
    setStatus(err.message, true);
    if (/won't let us/i.test(err.message)) showBlockedHelp();
  } finally {
    button.disabled = false;
    button.textContent = "Add";
  }
});

function setStatus(text, isError) {
  status.className = "status" + (isError ? " error" : "");
  status.textContent = text;
}

// ---------- routing ----------

window.addEventListener("hashchange", render);
render();

function render() {
  const m = location.hash.match(/^#\/r\/([^?]+)/);
  window.scrollTo(0, 0);
  if (m) {
    renderRecipe(decodeURIComponent(m[1]));
  } else {
    document.title = "Recipe Box";
    renderHome();
  }
}

// ---------- home ----------

async function renderHome() {
  app.replaceChildren(document.getElementById("home-tpl").content.cloneNode(true));
  const grid = document.getElementById("grid");
  const search = document.getElementById("search");
  const sort = document.getElementById("sort");

  search.value = view.query;
  sort.value = view.sort;
  search.addEventListener("input", () => { view.query = search.value; drawGrid(); });
  sort.addEventListener("change", () => { view.sort = sort.value; save("sort", view.sort); drawGrid(); });
  app.querySelectorAll(".pill").forEach((p) =>
    p.addEventListener("click", () => { view.filter = p.dataset.filter; save("filter", view.filter); drawGrid(); })
  );

  // The bookmarklet import redirects here with ?error=… if something failed.
  const err = new URLSearchParams(location.hash.split("?")[1] || "").get("error");
  if (err) setStatus(err, true);

  if (!cache) {
    grid.innerHTML = `<p class="empty">Loading…</p>`;
    try {
      cache = (await api()).recipes;
    } catch (e) {
      grid.innerHTML = `<p class="empty error">Couldn't load recipes: ${esc(e.message)}</p>`;
      return;
    }
  }
  drawGrid();
}

function drawGrid() {
  const grid = document.getElementById("grid");
  if (!grid) return;

  const counts = { all: cache.length, made: cache.filter((r) => r.made).length };
  counts.todo = counts.all - counts.made;
  app.querySelectorAll(".pill").forEach((p) => {
    const on = p.dataset.filter === view.filter;
    p.classList.toggle("active", on);
    p.setAttribute("aria-selected", on);
    p.querySelector(".count").textContent = counts[p.dataset.filter];
  });

  const q = view.query.trim().toLowerCase();
  const list = cache
    .filter((r) => view.filter === "all" || (view.filter === "made" ? r.made : !r.made))
    .filter((r) => !q || (r.name + " " + r.site).toLowerCase().includes(q))
    .sort((a, b) => {
      if (view.sort === "rating") return (b.rating || 0) - (a.rating || 0) || (b.made ? 1 : 0) - (a.made ? 1 : 0);
      if (view.sort === "name") return a.name.localeCompare(b.name);
      return 0; // the API already returns newest first
    });

  if (!cache.length) {
    grid.innerHTML = `<p class="empty"><span class="big">🥄</span>The box is empty. Paste a recipe link up top to add the first one!</p>`;
    return;
  }
  if (!list.length) {
    const msg = q
      ? `Nothing matches “${esc(view.query)}”.`
      : view.filter === "made"
        ? "Nothing made yet. Time to cook something!"
        : "You've made everything. Go find something new!";
    grid.innerHTML = `<p class="empty">${msg}</p>`;
    return;
  }

  grid.innerHTML = list
    .map(
      (r, i) => `
      <div class="card${r.made ? " is-made" : ""}" style="--i:${i % 5}">
        <a class="card-link" href="#/r/${encodeURIComponent(r.id)}">
          <div class="thumb">
            ${r.image ? `<img src="${esc(r.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
            ${r.made ? `<span class="badge">✓ Made it</span>` : ""}
          </div>
          <div class="card-body">
            <h3>${esc(r.name)}</h3>
            <p class="site">${esc(r.site || "")}</p>
          </div>
        </a>
        <div class="card-foot">
          <button type="button" class="made-chip" data-id="${esc(r.id)}" aria-pressed="${!!r.made}">
            ${r.made ? "✓ Made" : "Mark made"}
          </button>
          ${r.made && r.rating ? `<span class="stars-mini" aria-label="${r.rating} out of 5 stars">${starText(r.rating)}</span>` : ""}
        </div>
      </div>`
    )
    .join("");

  grid.querySelectorAll(".made-chip").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const r = cache.find((x) => x.id === btn.dataset.id);
      const made = !r.made;
      if (made) confetti(btn);
      r.made = made; // optimistic
      drawGrid();
      try {
        await updateRecipe(r.id, { made });
      } catch (err) {
        r.made = !made;
        drawGrid();
        setStatus(err.message, true);
      }
    })
  );
}

function starText(n) {
  return "★".repeat(n) + "☆".repeat(5 - n);
}

// ---------- recipe ----------

async function renderRecipe(id) {
  app.innerHTML = `<p class="empty">Loading…</p>`;
  let r;
  try {
    r = (await api("/" + encodeURIComponent(id))).recipe;
  } catch (err) {
    app.innerHTML = `<p class="empty error">${esc(err.message)}</p><p class="empty"><a href="#/">← Back to recipes</a></p>`;
    return;
  }

  const times = [
    ["⏱ Prep", r.prepTime],
    ["🔥 Cook", r.cookTime],
    ["⏰ Total", r.totalTime],
    ["🍽 Makes", r.yield],
  ].filter(([, v]) => v);

  document.title = r.name + " · Recipe Box";
  app.innerHTML = `
    <article class="recipe">
      <a href="#/" class="back no-print">← All recipes</a>
      ${r.image ? `<img class="hero" src="${esc(r.image)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
      <h1>${esc(r.name)}</h1>
      ${times.length ? `<ul class="chips">${times.map(([k, v]) => `<li><span>${k}</span> ${esc(v)}</li>`).join("")}</ul>` : ""}
      <p class="from">From <a href="${esc(r.source)}" target="_blank" rel="noopener">${esc(r.site)}</a></p>

      <section class="status-panel no-print" aria-label="Your notes">
        <label class="switch">
          <input type="checkbox" id="made" role="switch" ${r.made ? "checked" : ""}>
          <span class="track" aria-hidden="true"><span class="knob"></span></span>
          <span class="switch-label">We've made this</span>
        </label>
        <div class="rater" role="radiogroup" aria-label="Rating"></div>
      </section>

      <div class="cols">
        <section class="ingredients">
          <h2>Ingredients</h2>
          <ul>
            ${r.ingredients.map((i, n) => `<li><label><input type="checkbox" id="ing-${n}"><span>${esc(i)}</span></label></li>`).join("")}
          </ul>
        </section>

        <section class="steps">
          <h2>Steps</h2>
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
        <button type="button" id="print" class="ghost">🖨 Print</button>
        <button type="button" id="delete" class="ghost danger">Delete</button>
      </footer>
    </article>`;

  const madeBox = document.getElementById("made");
  const rater = app.querySelector(".rater");

  const drawRater = () => {
    rater.classList.toggle("locked", !r.made);
    rater.innerHTML = r.made
      ? [1, 2, 3, 4, 5]
          .map(
            (n) =>
              `<button type="button" class="star${n <= r.rating ? " on" : ""}" role="radio" aria-checked="${n === r.rating}" aria-label="${n} star${n > 1 ? "s" : ""}" data-n="${n}">★</button>`
          )
          .join("") + `<span class="rater-hint">${r.rating ? ["", "Meh", "Okay", "Good", "Great", "Amazing!"][r.rating] : "Rate it!"}</span>`
      : `<span class="rater-hint">Make it, then rate it ⭐</span>`;
    rater.querySelectorAll(".star").forEach((b) =>
      b.addEventListener("click", async () => {
        const n = Number(b.dataset.n);
        const prev = r.rating;
        r.rating = n === prev ? 0 : n; // tap the same star again to clear
        drawRater();
        if (r.rating) rater.querySelector(`[data-n="${r.rating}"]`).classList.add("pop");
        try {
          await updateRecipe(r.id, { rating: r.rating });
        } catch (err) {
          r.rating = prev;
          drawRater();
          alert(err.message);
        }
      })
    );
  };
  drawRater();

  madeBox.addEventListener("change", async () => {
    r.made = madeBox.checked;
    if (r.made) confetti(madeBox.parentElement);
    drawRater();
    try {
      await updateRecipe(r.id, { made: r.made });
    } catch (err) {
      r.made = !r.made;
      madeBox.checked = r.made;
      drawRater();
      alert(err.message);
    }
  });

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

// ---------- blocked sites: bookmarklet ----------
// Shown only when a site refuses our server. Runs on the recipe site in the
// user's own browser: collects the page's recipe data (JSON-LD) and form-posts
// it to the worker, which redirects back here.

function bookmarkletCode() {
  const importUrl = API_BASE + "/api/import";
  const src = `(()=>{
    const d=[...document.querySelectorAll('script[type="application/ld+json"]')]
      .map(s=>'<script type="application/ld+json">'+s.textContent+'</scr'+'ipt>').join('');
    if(!d){alert('No recipe found on this page.');return}
    const f=document.createElement('form');f.method='POST';f.action=${JSON.stringify(importUrl)};
    [['url',location.href],['data',d]].forEach(([k,v])=>{
      const i=document.createElement('input');i.type='hidden';i.name=k;i.value=v;f.appendChild(i)});
    document.body.appendChild(f);f.submit();
  })()`;
  return "javascript:" + encodeURIComponent(src.replace(/\n\s*/g, ""));
}

function showBlockedHelp() {
  const help = document.getElementById("blocked-tpl").content.cloneNode(true);
  const link = help.querySelector(".bm-button");
  const copy = help.querySelector(".bm-copy");
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
  status.append(help);
}

// ---------- fun ----------

function confetti(origin) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const layer = document.getElementById("confetti");
  const box = origin.getBoundingClientRect();
  const colors = ["#1c77c3", "#39a9db", "#40bcd8", "#f39237", "#d63230"];
  for (let i = 0; i < 28; i++) {
    const bit = document.createElement("i");
    const angle = Math.random() * Math.PI * 2;
    const dist = 60 + Math.random() * 90;
    bit.style.cssText = `left:${box.left + box.width / 2}px;top:${box.top + box.height / 2}px;background:${colors[i % 5]};--dx:${Math.cos(angle) * dist}px;--dy:${Math.sin(angle) * dist - 40}px;--r:${Math.random() * 720 - 360}deg`;
    layer.append(bit);
    setTimeout(() => bit.remove(), 900);
  }
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
