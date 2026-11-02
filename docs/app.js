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

function summarize(r) {
  return { id: r.id, name: r.name, image: r.image, site: r.site, addedAt: r.addedAt, made: !!r.made, rating: r.rating || 0 };
}

function load(key, fallback) {
  try { return localStorage.getItem("rb-" + key) || fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem("rb-" + key, value); } catch {}
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
    document.title = "A+M Recipe Box";
    renderHome();
  }
}

// ---------- home ----------

async function renderHome() {
  app.replaceChildren(document.getElementById("home-tpl").content.cloneNode(true));
  const grid = document.getElementById("grid");
  const search = document.getElementById("search");
  const sort = document.getElementById("sort");

  setupAddForm();
  search.value = view.query;
  sort.value = view.sort;
  search.addEventListener("input", () => { view.query = search.value; drawGrid(); });
  sort.addEventListener("change", () => { view.sort = sort.value; save("sort", view.sort); drawGrid(); });
  app.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => { view.filter = t.dataset.filter; save("filter", view.filter); drawGrid(); })
  );

  // The bookmarklet import redirects here with ?error=… if something failed.
  const err = new URLSearchParams(location.hash.split("?")[1] || "").get("error");
  if (err) setStatus(err, true);

  if (!cache) {
    grid.innerHTML = `<p class="empty">Loading…</p>`;
    try {
      const fresh = (await api()).recipes;
      // Cloudflare's list can lag a minute behind; keep anything we just added.
      const pending = JSON.parse(sessionStorage.getItem("rb-added") || "[]").filter((p) => !fresh.some((r) => r.id === p.id));
      cache = [...pending, ...fresh];
    } catch (e) {
      grid.innerHTML = `<p class="empty error">Couldn't load recipes: ${esc(e.message)}</p>`;
      return;
    }
  }
  drawGrid();
}

function setupAddForm() {
  const form = document.getElementById("add-form");
  const input = document.getElementById("url");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    button.textContent = "Adding…";
    setStatus("");
    try {
      const { recipe, duplicate } = await api("", { method: "POST", body: JSON.stringify({ url: input.value }) });
      if (!duplicate) rememberAdded(recipe);
      location.hash = "#/r/" + encodeURIComponent(recipe.id);
    } catch (err) {
      setStatus(err.message, true);
      if (/won't let us/i.test(err.message)) showBlockedHelp();
      button.disabled = false;
      button.textContent = "Add recipe";
    }
  });
}

function rememberAdded(recipe) {
  const s = summarize(recipe);
  if (cache) cache.unshift(s);
  try {
    const list = JSON.parse(sessionStorage.getItem("rb-added") || "[]");
    sessionStorage.setItem("rb-added", JSON.stringify([s, ...list].slice(0, 20)));
  } catch {}
}

function setStatus(text, isError) {
  const status = document.getElementById("add-status");
  if (!status) return;
  status.className = "status" + (isError ? " error" : "");
  status.textContent = text;
}

function drawGrid() {
  const grid = document.getElementById("grid");
  if (!grid) return;

  const counts = { all: cache.length, made: cache.filter((r) => r.made).length };
  counts.todo = counts.all - counts.made;
  app.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.filter === view.filter;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on);
    t.querySelector(".count").textContent = counts[t.dataset.filter];
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
    grid.innerHTML = `<p class="empty">No recipes yet. Paste a link above to add the first one.</p>`;
    return;
  }
  if (!list.length) {
    const msg = q
      ? `Nothing matches “${esc(view.query)}”.`
      : view.filter === "made"
        ? "Nothing made yet."
        : "You've made everything on the list.";
    grid.innerHTML = `<p class="empty">${msg}</p>`;
    return;
  }

  grid.innerHTML = list
    .map(
      (r) => `
      <div class="card">
        <a class="card-link" href="#/r/${encodeURIComponent(r.id)}">
          <div class="thumb">
            ${r.image ? `<img src="${esc(r.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
            ${r.made ? `<span class="badge">Made it</span>` : ""}
          </div>
          <h3>${esc(r.name)}</h3>
        </a>
        ${r.made && r.rating ? `<div class="stars-mini" aria-label="${r.rating} out of 5 stars">${starText(r.rating)}</div>` : ""}
        <button type="button" class="made-chip" data-id="${esc(r.id)}" aria-pressed="${!!r.made}">
          ${r.made ? "✓ Made" : "Mark as made"}
        </button>
      </div>`
    )
    .join("");

  grid.querySelectorAll(".made-chip").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const r = cache.find((x) => x.id === btn.dataset.id);
      const made = !r.made;
      r.made = made; // optimistic
      drawGrid();
      try {
        await updateRecipe(r.id, { made });
        if (made) checkMilestone(r.id);
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
  // Covers recipes added through the bookmarklet, which lands straight here.
  if (cache && !cache.some((x) => x.id === r.id)) rememberAdded(r);

  const times = [
    ["Prep", r.prepTime],
    ["Cook", r.cookTime],
    ["Total", r.totalTime],
    ["Makes", r.yield],
  ].filter(([, v]) => v);

  document.title = r.name + " · A+M Recipe Box";
  app.innerHTML = `
    <article class="recipe">
      <a href="#/" class="back no-print">← All recipes</a>
      <h1>${esc(r.name)}</h1>
      ${times.length ? `<dl class="meta">${times.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` : ""}
      ${r.image ? `<img class="hero-img" src="${esc(r.image)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}

      <section class="status-panel no-print" aria-label="Made it and rating">
        <label class="switch">
          <input type="checkbox" id="made" role="switch" ${r.made ? "checked" : ""}>
          <span class="track" aria-hidden="true"><span class="knob"></span></span>
          <span>We've made this</span>
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
          <h2>Directions</h2>
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
        <a href="${esc(r.source)}" target="_blank" rel="noopener">View original on ${esc(r.site)}</a>
        <span class="spacer"></span>
        <button type="button" id="print" class="link-btn">Print</button>
        <button type="button" id="delete" class="link-btn danger">Delete</button>
      </footer>
    </article>`;

  const madeBox = document.getElementById("made");
  const rater = app.querySelector(".rater");

  const drawRater = () => {
    rater.innerHTML = r.made
      ? [1, 2, 3, 4, 5]
          .map(
            (n) =>
              `<button type="button" class="star${n <= r.rating ? " on" : ""}" role="radio" aria-checked="${n === r.rating}" aria-label="${n} star${n > 1 ? "s" : ""}" data-n="${n}">★</button>`
          )
          .join("")
      : `<span class="hint">Rate it after you make it</span>`;
    rater.querySelectorAll(".star").forEach((b) =>
      b.addEventListener("click", async () => {
        const n = Number(b.dataset.n);
        const prev = r.rating;
        r.rating = n === prev ? 0 : n; // tap the same star again to clear
        drawRater();
        if (r.rating === 5) bubble("🤌 Chef's kiss!");
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
    drawRater();
    try {
      await updateRecipe(r.id, { made: r.made });
      if (r.made) checkMilestone(r.id);
    } catch (err) {
      r.made = !r.made;
      madeBox.checked = r.made;
      drawRater();
      alert(err.message);
    }
  });

  const boxes = [...app.querySelectorAll(".ingredients input")];
  boxes.forEach((b) =>
    b.addEventListener("change", () => {
      if (b.checked && boxes.every((x) => x.checked)) bubble("🛒 Shopping done ✓");
    })
  );

  // Tap a step to mark it done.
  app.querySelectorAll(".steps li").forEach((li) => li.addEventListener("click", () => li.classList.toggle("done")));
  document.getElementById("print").addEventListener("click", () => window.print());
  document.getElementById("delete").addEventListener("click", async () => {
    if (!confirm(`Delete “${r.name}”?`)) return;
    try {
      await api("/" + encodeURIComponent(id), { method: "DELETE" });
      if (cache) cache = cache.filter((x) => x.id !== id);
      try {
        const list = JSON.parse(sessionStorage.getItem("rb-added") || "[]");
        sessionStorage.setItem("rb-added", JSON.stringify(list.filter((x) => x.id !== id)));
      } catch {}
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
  document.getElementById("add-status").append(help);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---------- easter eggs ----------

// A floating message bubble. Centered by default; `random` drops it somewhere on screen.
function bubble(text, { random = false, ms = 2200 } = {}) {
  const el = document.createElement("div");
  el.className = "bubble" + (random ? " roam" : "");
  el.textContent = text;
  if (random) {
    el.style.left = `min(${5 + Math.random() * 65}vw, calc(100vw - 180px))`;
    el.style.top = 15 + Math.random() * 65 + "vh";
  }
  el.addEventListener("click", () => el.remove());
  document.body.append(el);
  setTimeout(() => el.classList.add("out"), ms);
  setTimeout(() => el.remove(), ms + 400);
}

// Tap the title 5 times quickly: the site becomes the Alaskan Salmon box (and back).
(() => {
  const brand = document.querySelector(".brand");
  let taps = 0, timer;
  brand.addEventListener("click", () => {
    clearTimeout(timer);
    timer = setTimeout(() => (taps = 0), 1500);
    if (++taps < 5) return;
    taps = 0;
    const salmon = brand.textContent !== "Alaskan Salmon";
    brand.textContent = salmon ? "Alaskan Salmon" : "A+M Recipe Box";
    if (salmon) bubble("🐟");
  });
})();

// Milestones for meals made: a one-time celebration at 10, 25, 50, 100.
async function checkMilestone(justMadeId) {
  try {
    const list = cache || (await api()).recipes;
    // The list can lag a moment behind the save, so count this one regardless.
    const made = list.filter((r) => r.made || r.id === justMadeId).length;
    const hit = [10, 25, 50, 100].find((n) => n === made);
    if (!hit || load("milestone-" + hit, "")) return;
    save("milestone-" + hit, "1");
    bubble(`🎉 ${hit} meals made together!`, { ms: 4000 });
  } catch {}
}

// Shake the phone: "What should we make tonight?"
async function randomPick() {
  try {
    if (!cache) cache = (await api()).recipes;
  } catch {
    return;
  }
  const pool = cache.filter((r) => !r.made).length ? cache.filter((r) => !r.made) : cache;
  if (!pool.length) return;
  const r = pool[Math.floor(Math.random() * pool.length)];
  document.querySelector(".pick")?.remove();
  const el = document.createElement("div");
  el.className = "pick";
  el.innerHTML = `
    <div class="pick-card" role="dialog" aria-label="Random recipe pick">
      <p class="pick-q">What should we make tonight?</p>
      ${r.image ? `<img src="${esc(r.image)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
      <h3>${esc(r.name)}</h3>
      <div class="pick-actions">
        <a class="btn" href="#/r/${encodeURIComponent(r.id)}">Let's make it</a>
        <button type="button" class="link-btn again">Pick another</button>
      </div>
    </div>`;
  el.addEventListener("click", (e) => {
    if (e.target === el || e.target.closest("a")) el.remove();
    if (e.target.closest(".again")) randomPick();
  });
  document.body.append(el);
}

(() => {
  let last = null, cooldown = 0;
  const onMotion = (e) => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    if (last) {
      const jolt = Math.abs(a.x - last.x) + Math.abs(a.y - last.y) + Math.abs(a.z - last.z);
      if (jolt > 35 && Date.now() > cooldown) {
        cooldown = Date.now() + 2500;
        randomPick();
      }
    }
    last = { x: a.x, y: a.y, z: a.z };
  };
  // iPhones only allow motion access after a tap, and ask once.
  if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
    document.addEventListener(
      "click",
      () => DeviceMotionEvent.requestPermission().then((p) => p === "granted" && addEventListener("devicemotion", onMotion)).catch(() => {}),
      { once: true }
    );
  } else {
    addEventListener("devicemotion", onMotion);
  }
})();

// Every so often, a little "I love you!" pops up somewhere.
(function loveNote() {
  const wait = (90 + Math.random() * 210) * 1000; // 1.5 to 5 minutes
  setTimeout(() => {
    if (!document.hidden) bubble("I love you! ❤️", { random: true, ms: 3500 });
    loveNote();
  }, wait);
})();
