const API_BASE = (window.RECIPE_API || "").replace(/\/+$/, "");
const API = API_BASE + "/api/recipes";
const app = document.getElementById("app");
let cache = null; // list of recipe summaries
const view = { filter: load("filter", "all"), sort: load("sort", "new"), query: "" };

// ---------- API ----------

async function request(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function api(path = "", opts = {}) {
  return request(API + path, opts);
}

async function updateRecipe(id, changes) {
  const { recipe } = await api("/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify(changes) });
  const summary = cache && cache.find((r) => r.id === id);
  if (summary) Object.assign(summary, { made: recipe.made, rating: recipe.rating });
  return recipe;
}

async function loadRecipes() {
  if (cache) return cache;
  const fresh = (await api()).recipes;
  // Cloudflare's list can lag a minute behind; keep anything we just added.
  let pending = [];
  try {
    pending = JSON.parse(sessionStorage.getItem("rb-added") || "[]").filter((p) => !fresh.some((r) => r.id === p.id));
  } catch {}
  cache = [...pending, ...fresh];
  return cache;
}

function summarize(r) {
  return { id: r.id, name: r.name, image: r.image, site: r.site, addedAt: r.addedAt, made: !!r.made, rating: r.rating || 0 };
}

function rememberAdded(recipe) {
  const s = summarize(recipe);
  if (cache && !cache.some((x) => x.id === s.id)) cache.unshift(s);
  try {
    const list = JSON.parse(sessionStorage.getItem("rb-added") || "[]");
    sessionStorage.setItem("rb-added", JSON.stringify([s, ...list.filter((x) => x.id !== s.id)].slice(0, 20)));
  } catch {}
}

function load(key, fallback) {
  try { return localStorage.getItem("rb-" + key) || fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem("rb-" + key, value); } catch {}
}

// ---------- shared lists (cart + pantry, stored in the worker) ----------

const shared = { cart: null, pantry: null };
const defaults = { cart: () => [], pantry: defaultPantry };

async function loadShared(name, fresh = false) {
  if (shared[name] && !fresh) return shared[name];
  const { items } = await request(`${API_BASE}/api/state/${name}`);
  shared[name] = items || defaults[name]();
  if (name === "cart") updateNav();
  return shared[name];
}

// Apply `fn` locally right away, then to the latest saved copy, so two
// phones editing at once don't wipe each other out. `fn` must be safe to
// apply twice (add/remove, not toggle).
async function changeShared(name, fn) {
  shared[name] = fn(shared[name] || defaults[name]());
  if (name === "cart") updateNav();
  const { items } = await request(`${API_BASE}/api/state/${name}`);
  const next = fn(items || defaults[name]());
  shared[name] = next;
  await request(`${API_BASE}/api/state/${name}`, { method: "PUT", body: JSON.stringify({ items: next }) });
  if (name === "cart") updateNav();
  return next;
}

const inCart = (id) => !!shared.cart && shared.cart.includes(id);
const setInCart = (id, on) => changeShared("cart", (list) => (on ? (list.includes(id) ? list : [...list, id]) : list.filter((x) => x !== id)));

function updateNav() {
  const n = shared.cart ? shared.cart.length : 0;
  document.getElementById("cart-count").textContent = n ? n : "";
  const route = location.hash.split("?")[0];
  document.querySelectorAll(".nav a").forEach((a) => {
    const here = a.dataset.route === "home" ? !/^#\/(cart|pantry)/.test(route) : route.startsWith("#/" + a.dataset.route);
    a.classList.toggle("active", here);
  });
}

// ---------- routing ----------

window.addEventListener("hashchange", render);
render();
loadShared("cart").catch(() => {});

function render() {
  const route = location.hash.split("?")[0];
  const m = route.match(/^#\/r\/(.+)$/);
  window.scrollTo(0, 0);
  updateNav();
  document.title = "A+M Recipe Box";
  if (m) renderRecipe(decodeURIComponent(m[1]));
  else if (route === "#/cart") renderCart();
  else if (route === "#/pantry") renderPantry();
  else if (route === "#/new") renderNewRecipe();
  else renderHome();
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
  document.getElementById("pick").addEventListener("click", () => {
    askForMotion();
    randomPick();
  });

  // The bookmarklet import redirects here with ?error=… if something failed.
  const err = new URLSearchParams(location.hash.split("?")[1] || "").get("error");
  if (err) setStatus(err, true);

  if (!cache) grid.innerHTML = `<p class="empty">Loading…</p>`;
  try {
    await Promise.all([loadRecipes(), loadShared("cart").catch(() => {})]);
  } catch (e) {
    grid.innerHTML = `<p class="empty error">Couldn't load recipes: ${esc(e.message)}</p>`;
    return;
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

function setStatus(text, isError) {
  const status = document.getElementById("add-status");
  if (!status) return;
  status.className = "status" + (isError ? " error" : "");
  status.textContent = text;
}

function drawGrid() {
  const grid = document.getElementById("grid");
  if (!grid || !cache) return;

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
        <div class="card-actions">
          <button type="button" class="chip-btn made-chip" data-id="${esc(r.id)}" aria-pressed="${!!r.made}">${r.made ? "✓ Made" : "Mark made"}</button>
          <button type="button" class="chip-btn cart-chip" data-id="${esc(r.id)}" aria-pressed="${inCart(r.id)}">${inCart(r.id) ? "✓ In cart" : "+ Cart"}</button>
        </div>
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
  grid.querySelectorAll(".cart-chip").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const on = !inCart(id);
      const done = setInCart(id, on);
      drawGrid();
      try {
        await done;
      } catch (err) {
        setStatus(err.message, true);
      }
      drawGrid();
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
    [r] = await Promise.all([api("/" + encodeURIComponent(id)).then((d) => d.recipe), loadShared("cart").catch(() => {})]);
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

      <section class="status-panel no-print" aria-label="Made it, rating and cart">
        <label class="switch">
          <input type="checkbox" id="made" role="switch" ${r.made ? "checked" : ""}>
          <span class="track" aria-hidden="true"><span class="knob"></span></span>
          <span>We've made this</span>
        </label>
        <div class="rater" role="radiogroup" aria-label="Rating"></div>
        <button type="button" id="cart-btn" class="btn-outline"></button>
      </section>

      <div class="cols">
        ${
          r.ingredients.length
            ? `<section class="ingredients">
          <div class="panel-head">
            <h2>Ingredients</h2>
            <button type="button" id="uncheck" class="link-btn no-print">Uncheck all</button>
          </div>
          <ul>
            ${r.ingredients.map((i, n) => `<li><label><input type="checkbox" id="ing-${n}"><span>${esc(i)}</span></label></li>`).join("")}
          </ul>
        </section>`
            : ""
        }

        ${
          r.instructions.length
            ? `<section class="steps">
          <h2>Directions</h2>
          ${r.instructions
            .map(
              (s) => `
              ${s.section ? `<h3>${esc(s.section)}</h3>` : ""}
              <ol>${s.steps.map((t) => `<li>${esc(t)}</li>`).join("")}</ol>`
            )
            .join("")}
        </section>`
            : ""
        }
      </div>

      <footer class="actions no-print">
        ${r.source ? `<a href="${esc(r.source)}" target="_blank" rel="noopener">View original on ${esc(r.site)}</a>` : ""}
        <span class="spacer"></span>
        <button type="button" id="print" class="link-btn">Print</button>
        <button type="button" id="delete" class="link-btn danger">Delete</button>
      </footer>
    </article>`;

  const madeBox = document.getElementById("made");
  const rater = app.querySelector(".rater");
  const cartBtn = document.getElementById("cart-btn");

  const drawCartBtn = () => {
    cartBtn.textContent = inCart(r.id) ? "✓ In this week's cart" : "+ Add to cart";
    cartBtn.classList.toggle("on", inCart(r.id));
  };
  drawCartBtn();
  cartBtn.addEventListener("click", async () => {
    const done = setInCart(r.id, !inCart(r.id));
    drawCartBtn();
    try {
      await done;
    } catch (err) {
      alert(err.message);
    }
    drawCartBtn();
  });

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
        if (r.rating === 5) confettiRain();
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
      if (b.checked && boxes.every((x) => x.checked)) bubble("Shopping done ✓");
    })
  );
  document.getElementById("uncheck")?.addEventListener("click", () => boxes.forEach((b) => (b.checked = false)));

  // Tap a step to mark it done.
  app.querySelectorAll(".steps li").forEach((li) => li.addEventListener("click", () => li.classList.toggle("done")));
  document.getElementById("print").addEventListener("click", () => window.print());
  document.getElementById("delete").addEventListener("click", async () => {
    if (!confirm(`Delete “${r.name}”?`)) return;
    try {
      await api("/" + encodeURIComponent(id), { method: "DELETE" });
      if (cache) cache = cache.filter((x) => x.id !== id);
      if (shared.cart) shared.cart = shared.cart.filter((x) => x !== id); // the worker drops it too
      updateNav();
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

// ---------- type a recipe in ----------

function renderNewRecipe() {
  document.title = "New recipe · A+M Recipe Box";
  app.innerHTML = `
    <article class="recipe">
      <a href="#/" class="back">← All recipes</a>
      <h1>Type in a recipe</h1>
      <p class="lede">For the ones from TikTok, Instagram, or a friend's kitchen.</p>
      <form id="manual" class="manual" autocomplete="off">
        <label>Name<input name="name" required maxlength="200" placeholder="Hot honey salmon bowls"></label>
        <label>Ingredients <span class="opt">one per line</span>
          <textarea name="ingredients" rows="8" placeholder="2 salmon fillets&#10;1 tbsp hot honey&#10;1 cup rice"></textarea></label>
        <label>Steps <span class="opt">one per line</span>
          <textarea name="instructions" rows="8" placeholder="Cook the rice.&#10;Glaze the salmon and bake at 400°F for 12 minutes."></textarea></label>
        <div class="row">
          <label>Makes <span class="opt">optional</span><input name="yield" maxlength="60" placeholder="2 servings"></label>
          <label>Total time <span class="opt">optional</span><input name="totalTime" maxlength="60" placeholder="30 min"></label>
        </div>
        <label>Where you found it <span class="opt">optional link</span><input name="source" type="url" inputmode="url" placeholder="https://www.tiktok.com/…"></label>
        <label>Photo <span class="opt">optional image link</span><input name="image" type="url" inputmode="url" placeholder="https://…/photo.jpg"></label>
        <p id="manual-status" class="status error" role="status"></p>
        <button type="submit" class="btn">Save recipe</button>
      </form>
    </article>`;

  const form = document.getElementById("manual");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const status = document.getElementById("manual-status");
    const button = form.querySelector("button");
    status.textContent = "";
    button.disabled = true;
    try {
      const { recipe } = await api("", { method: "POST", body: JSON.stringify({ manual: data }) });
      rememberAdded(recipe);
      location.hash = "#/r/" + encodeURIComponent(recipe.id);
    } catch (err) {
      status.textContent = err.message;
      button.disabled = false;
    }
  });
}

// ---------- cart: this week's recipes + shopping list ----------

async function renderCart() {
  document.title = "Cart · A+M Recipe Box";
  app.innerHTML = `<p class="empty">Loading…</p>`;
  let ids;
  try {
    ids = await loadShared("cart", true);
  } catch (err) {
    app.innerHTML = `<p class="empty error">Couldn't load the cart: ${esc(err.message)}</p>`;
    return;
  }

  if (!ids.length) {
    app.innerHTML = `
      <section class="page-head"><h1>This Week's Cart</h1></section>
      <p class="empty">Nothing in the cart yet. Tap <strong>+ Cart</strong> on any recipe to plan it for this week.<br><br><a href="#/">Browse recipes</a></p>`;
    return;
  }

  const recipes = (
    await Promise.all(ids.map((id) => api("/" + encodeURIComponent(id)).then((d) => d.recipe).catch(() => null)))
  ).filter(Boolean);

  const checked = new Set(JSON.parse(load("shop-checked", "[]")));
  const saveChecked = () => save("shop-checked", JSON.stringify([...checked]));

  const draw = () => {
    const toBuy = [];
    for (const r of recipes) {
      r.ingredients.forEach((text, n) => toBuy.push({ key: `${r.id}|${n}`, text, recipe: r }));
    }

    const groups = recipes
      .map((r) => {
        const items = toBuy.filter((i) => i.recipe === r);
        if (!items.length) return "";
        return `
          <h3>${esc(r.name)}</h3>
          <ul class="shop">${items
            .map(
              (i) => `
            <li><label><input type="checkbox" data-key="${esc(i.key)}" ${checked.has(i.key) ? "checked" : ""}><span>${esc(i.text)}</span></label></li>`
            )
            .join("")}</ul>`;
      })
      .join("");

    app.innerHTML = `
      <section class="page-head">
        <h1>This Week's Cart</h1>
        <p class="lede">${recipes.length} recipe${recipes.length === 1 ? "" : "s"} planned · ${toBuy.length} thing${toBuy.length === 1 ? "" : "s"} to buy</p>
      </section>

      <ul class="cart-recipes">
        ${recipes
          .map(
            (r) => `
          <li>
            <a href="#/r/${encodeURIComponent(r.id)}">
              <span class="mini-thumb">${r.image ? `<img src="${esc(r.image)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}</span>
              <span class="name">${esc(r.name)}</span>
            </a>
            <button type="button" class="link-btn remove" data-id="${esc(r.id)}">Remove</button>
          </li>`
          )
          .join("")}
      </ul>

      <section class="shopping">
        <div class="panel-head">
          <h2>Shopping list</h2>
          <div class="panel-actions">
            <button type="button" id="copy-list" class="link-btn">Copy list</button>
            <button type="button" id="uncheck-list" class="link-btn">Uncheck all</button>
            <button type="button" id="clear-cart" class="link-btn danger">Empty cart</button>
          </div>
        </div>
        ${groups || `<p class="hint">These recipes don't list any ingredients.</p>`}
      </section>`;

    app.querySelectorAll(".shop input").forEach((box) =>
      box.addEventListener("change", () => {
        box.checked ? checked.add(box.dataset.key) : checked.delete(box.dataset.key);
        saveChecked();
      })
    );
    document.getElementById("uncheck-list").addEventListener("click", () => {
      checked.clear();
      saveChecked();
      app.querySelectorAll(".shop input").forEach((b) => (b.checked = false));
    });
    document.getElementById("copy-list").addEventListener("click", async (e) => {
      const lines = recipes
        .map((r) => {
          const items = toBuy.filter((i) => i.recipe === r && !checked.has(i.key));
          return items.length ? `${r.name}\n${items.map((i) => "- " + i.text).join("\n")}` : "";
        })
        .filter(Boolean)
        .join("\n\n");
      try {
        await navigator.clipboard.writeText(lines);
        e.target.textContent = "Copied!";
        setTimeout(() => (e.target.textContent = "Copy list"), 1500);
      } catch {
        prompt("Copy this list:", lines);
      }
    });
    document.getElementById("clear-cart").addEventListener("click", async () => {
      if (!confirm("Empty this week's cart?")) return;
      checked.clear();
      saveChecked();
      try {
        await changeShared("cart", () => []);
      } catch (err) {
        alert(err.message);
      }
      renderCart();
    });
    app.querySelectorAll(".cart-recipes .remove").forEach((b) =>
      b.addEventListener("click", async () => {
        try {
          await setInCart(b.dataset.id, false);
        } catch (err) {
          alert(err.message);
        }
        renderCart();
      })
    );
  };

  draw();
}

// ---------- pantry ----------

function defaultPantry() {
  const groups = {
    "Spices & seasonings": ["salt", "black pepper", "garlic powder", "onion powder", "paprika", "chili powder", "cumin", "oregano", "italian seasoning", "red pepper flakes", "cinnamon"],
    "Oils, vinegars & sauces": ["olive oil", "vegetable oil", "sesame oil", "soy sauce", "vinegar", "honey", "hot sauce", "dijon mustard", "mayonnaise", "ketchup"],
    Baking: ["flour", "sugar", "brown sugar", "baking soda", "baking powder", "vanilla", "cornstarch"],
    "Grains & pasta": ["rice", "pasta", "oats", "bread crumbs", "tortillas"],
    "Cans & jars": ["chicken broth", "diced tomatoes", "tomato paste", "black beans", "coconut milk", "peanut butter"],
    "Fridge & freezer": ["butter", "egg", "milk", "parmesan", "cheddar", "heavy cream", "frozen peas"],
    Produce: ["garlic", "onion", "lemon", "lime", "potato"],
  };
  const items = [{ name: "water", cat: "Basics", have: true }];
  for (const [cat, names] of Object.entries(groups)) for (const name of names) items.push({ name, cat, have: false });
  return items;
}

async function renderPantry() {
  document.title = "Pantry · A+M Recipe Box";
  app.innerHTML = `<p class="empty">Loading…</p>`;
  let items;
  try {
    items = await loadShared("pantry", true);
  } catch (err) {
    app.innerHTML = `<p class="empty error">Couldn't load the pantry: ${esc(err.message)}</p>`;
    return;
  }

  const draw = () => {
    const cats = [...new Set(items.map((i) => i.cat))];
    const haveCount = items.filter((i) => i.have).length;
    app.innerHTML = `
      <section class="page-head">
        <h1>Pantry</h1>
        <p class="lede">Tap what you have on hand, so you can check before you shop.</p>
        <form id="pantry-add" class="add" autocomplete="off">
          <input id="pantry-name" placeholder="Add something (e.g. fish sauce)" required maxlength="60" aria-label="Pantry item">
          <button type="submit" class="btn">Add</button>
        </form>
        <p class="hint center">${haveCount} of ${items.length} on the shelf</p>
      </section>
      ${cats
        .map(
          (cat) => `
        <section class="shelf">
          <h2>${esc(cat)}</h2>
          <div class="chips">
            ${items
              .map((it, i) => ({ it, i }))
              .filter(({ it }) => it.cat === cat)
              .map(
                ({ it, i }) => `
              <span class="pantry-chip${it.have ? " have" : ""}">
                <button type="button" class="toggle" data-i="${i}" aria-pressed="${it.have}">${it.have ? "✓ " : ""}${esc(it.name)}</button>
                <button type="button" class="x" data-i="${i}" aria-label="Remove ${esc(it.name)}">×</button>
              </span>`
              )
              .join("")}
          </div>
        </section>`
        )
        .join("")}`;

    app.querySelectorAll(".pantry-chip .toggle").forEach((b) =>
      b.addEventListener("click", () => {
        const it = items[b.dataset.i];
        const have = !it.have;
        persist((list) => list.map((x) => (x.name === it.name ? { ...x, have } : x)));
      })
    );
    app.querySelectorAll(".pantry-chip .x").forEach((b) =>
      b.addEventListener("click", () => {
        const name = items[b.dataset.i].name;
        persist((list) => list.filter((x) => x.name !== name));
      })
    );
    document.getElementById("pantry-add").addEventListener("submit", (e) => {
      e.preventDefault();
      const name = document.getElementById("pantry-name").value.trim().toLowerCase();
      if (!name) return;
      persist((list) => (list.some((x) => x.name === name) ? list.map((x) => (x.name === name ? { ...x, have: true } : x)) : [...list, { name, cat: "Other", have: true }]));
    });
  };

  const persist = (fn) => {
    const done = changeShared("pantry", fn);
    items = shared.pantry;
    draw();
    done.then((next) => { items = next; }).catch((err) => alert(err.message));
  };

  draw();
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
function bubble(text, { random = false, ms = 2200, html = false } = {}) {
  const el = document.createElement("div");
  el.className = "bubble" + (random ? " roam" : "");
  el[html ? "innerHTML" : "textContent"] = text;
  if (random) {
    el.style.left = `min(${5 + Math.random() * 65}vw, calc(100vw - 180px))`;
    el.style.top = 15 + Math.random() * 65 + "vh";
  }
  el.addEventListener("click", () => el.remove());
  document.body.append(el);
  setTimeout(() => el.classList.add("out"), ms);
  setTimeout(() => el.remove(), ms + 400);
}

const HEART = `<svg class="heart" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-10-9.3C.4 8.4 2.2 4.5 6 4.5c2.3 0 3.6 1.3 4.5 2.6.3.4.9.4 1.2 0 .9-1.3 2.2-2.6 4.5-2.6 3.8 0 5.6 3.9 4 7.2C19.5 16.4 12 21 12 21z"/></svg>`;
const FISH = `<svg viewBox="0 0 64 32" aria-hidden="true"><path class="fish-tail" d="M50 16 63 5v22z"/><ellipse class="fish-body" cx="28" cy="16" rx="25" ry="11"/><path class="fish-fin" d="M22 6c4-5 12-5 15 0z"/><circle class="fish-eye" cx="13" cy="13" r="2.4"/></svg>`;

// Confetti rains down the whole screen (5-star ratings).
function confettiRain() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const layer = document.createElement("div");
  layer.className = "rain";
  const colors = ["#1c77c3", "#39a9db", "#40bcd8", "#f39237", "#d63230"];
  for (let i = 0; i < 140; i++) {
    const bit = document.createElement("i");
    bit.style.cssText = `left:${Math.random() * 100}vw;background:${colors[i % colors.length]};--d:${2 + Math.random() * 1.6}s;--delay:${Math.random() * 0.9}s;--sway:${Math.random() * 120 - 60}px;--spin:${Math.random() * 1080 - 540}deg;width:${6 + Math.random() * 6}px`;
    layer.append(bit);
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 4800);
}

// The little fish in the footer: a salmon run, then a note for Alaskan Salmon.
(() => {
  const btn = document.getElementById("fish");
  btn.innerHTML = FISH;
  btn.addEventListener("click", () => {
    if (document.querySelector(".run")) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced) {
      const run = document.createElement("div");
      run.className = "run";
      for (let i = 0; i < 16; i++) {
        const f = document.createElement("span");
        f.className = "leaper";
        const size = 40 + Math.random() * 50;
        f.style.cssText = `--s:${size}px;--y:${Math.random() * 30 - 8}vh;--h:${25 + Math.random() * 40}vh;--d:${1.6 + Math.random() * 1.2}s;--delay:${i * 0.12 + Math.random() * 0.3}s`;
        f.innerHTML = `<span class="hop">${FISH}</span>`;
        run.append(f);
      }
      document.body.append(run);
      setTimeout(() => run.remove(), 5200);
    }
    setTimeout(showSalmonNote, reduced ? 0 : 2600);
  });
})();

function showSalmonNote() {
  const el = document.createElement("div");
  el.className = "pick";
  el.innerHTML = `
    <div class="pick-card salmon-card" role="dialog" aria-label="A note for Alaskan Salmon">
      <button type="button" class="close-x" aria-label="Close">×</button>
      <div class="salmon-fish">${FISH}</div>
      <h2>I love you, Alaskan Salmon</h2>
    </div>`;
  el.addEventListener("click", (e) => {
    if (e.target !== el && !e.target.closest(".close-x")) return;
    el.remove();
    document.querySelector(".brand").textContent = "Alaskan Salmon's Recipe Box";
  });
  document.body.append(el);
}

// Milestones for meals made: a one-time celebration at 10, 25, 50, 100.
async function checkMilestone(justMadeId) {
  try {
    const list = await loadRecipes();
    // The list can lag a moment behind the save, so count this one regardless.
    const made = list.filter((r) => r.made || r.id === justMadeId).length;
    const hit = [10, 25, 50, 100].find((n) => n === made);
    if (!hit || load("milestone-" + hit, "")) return;
    save("milestone-" + hit, "1");
    bubble(`${hit} meals made together!`, { ms: 4000 });
  } catch {}
}

// "What should we make tonight?" — from the Pick for me button, or by shaking a phone.
async function randomPick() {
  let list;
  try {
    list = await loadRecipes();
  } catch {
    return;
  }
  const todo = list.filter((r) => !r.made);
  const pool = todo.length ? todo : list;
  if (!pool.length) return;
  const current = document.querySelector(".pick h3")?.textContent;
  const choices = pool.length > 1 ? pool.filter((r) => r.name !== current) : pool; // don't repeat on "pick another"
  const r = choices[Math.floor(Math.random() * choices.length)];
  document.querySelector(".pick")?.remove();
  const el = document.createElement("div");
  el.className = "pick";
  el.innerHTML = `
    <div class="pick-card" role="dialog" aria-label="Random recipe pick">
      <button type="button" class="close-x" aria-label="Close">×</button>
      <p class="pick-q">What should we make tonight?</p>
      ${r.image ? `<img src="${esc(r.image)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
      <h3>${esc(r.name)}</h3>
      <div class="pick-actions">
        <a class="btn" href="#/r/${encodeURIComponent(r.id)}">Let's make it</a>
        <button type="button" class="link-btn again">Pick another</button>
      </div>
    </div>`;
  el.addEventListener("click", (e) => {
    if (e.target === el || e.target.closest("a") || e.target.closest(".close-x")) el.remove();
    if (e.target.closest(".again")) randomPick();
  });
  document.body.append(el);
}

// Shake detection. A shake is a few hard jolts within about a second; one
// bump (setting the phone down) isn't enough.
let motionAsked = false;
function onMotion(e) {
  const a = e.acceleration && e.acceleration.x != null ? e.acceleration : null;
  const g = e.accelerationIncludingGravity;
  let force;
  if (a) force = Math.hypot(a.x, a.y, a.z);
  else if (g && g.x != null) force = Math.abs(Math.hypot(g.x, g.y, g.z) - 9.81);
  else return;
  const now = Date.now();
  if (now < onMotion.cooldown) return;
  if (force > 13) {
    onMotion.peaks = (onMotion.peaks || []).filter((t) => now - t < 1000);
    onMotion.peaks.push(now);
    if (onMotion.peaks.length >= 3) {
      onMotion.peaks = [];
      onMotion.cooldown = now + 2500;
      randomPick();
    }
  }
}
onMotion.cooldown = 0;

// iPhones only allow motion access after a tap, and show their own prompt once.
function askForMotion() {
  if (motionAsked) return;
  motionAsked = true;
  if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
    DeviceMotionEvent.requestPermission()
      .then((p) => p === "granted" && addEventListener("devicemotion", onMotion))
      .catch(() => (motionAsked = false));
  } else {
    addEventListener("devicemotion", onMotion);
  }
}
if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
  document.addEventListener("click", askForMotion, { once: true });
} else {
  askForMotion();
}

// Every so often, a little "I love you!" pops up somewhere.
(function loveNote() {
  const wait = (90 + Math.random() * 210) * 1000; // 1.5 to 5 minutes
  setTimeout(() => {
    if (!document.hidden) bubble(`I love you! ${HEART}`, { random: true, ms: 3500, html: true });
    loveNote();
  }, wait);
})();
