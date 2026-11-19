import { call, esc, bytes, plural, toast, confirmAction, icons, bus, go, store } from "./core.js";

let root;
let items = [];
let pending = 0;
let selected = new Set();
let touched = false;
let open = new Set(["Trash", "App caches", "Developer caches", "System"]);
let poll = null;
let running = false;
let scanned = false;
let lastResult = null;

const GROUP_INFO = {
  Trash: "Files you deleted but that still use space.",
  "App caches": "Temporary data apps rebuild on their own. Close an app before cleaning its cache.",
  "Developer caches": "Downloaded packages and build caches. Tools fetch them again when needed.",
  System: "Package downloads, old logs and crash reports. Needs your administrator password.",
  "Other folders in ~/.cache": "These folders are not known caches. Some apps keep real work here, so check each one before selecting it.",
};

async function scan() {
  clearTimeout(poll);
  scanned = true;
  lastResult = null;
  items = [];
  render();
  try {
    const v = await call("cleanup_scan");
    apply(v, true);
  } catch (e) {
    toast(e.message, "bad");
  }
}

function apply(v, reset) {
  items = v.items;
  pending = v.pending;
  if (reset || !touched) {
    selected = new Set(items.filter((i) => i.selected).map((i) => i.id));
  } else {
    const ids = new Set(items.map((i) => i.id));
    selected = new Set([...selected].filter((id) => ids.has(id)));
  }
  render();
  if (pending > 0) poll = setTimeout(() => call("cleanup_items").then((r) => apply(r, false)).catch(() => {}), 600);
}

function totals() {
  let sel = 0;
  let all = 0;
  let root = false;
  for (const i of items) {
    const s = i.size || 0;
    if (i.group !== "Other folders in ~/.cache") all += s;
    if (selected.has(i.id)) {
      sel += s;
      if (i.needs_root) root = true;
    }
  }
  return { sel, all, root, count: [...selected].filter((id) => items.some((i) => i.id === id)).length };
}

function render() {
  const t = totals();
  const hero = root.querySelector("#cl-hero");
  const measuring = pending > 0;
  if (!scanned) {
    hero.innerHTML = "";
  } else if (!items.length) {
    hero.innerHTML = `<div class="spinner"></div><div class="grow"><b>Looking for things to clean…</b></div>`;
  } else {
    hero.innerHTML = `<div class="grow"><div class="amount num">${bytes(t.sel)}</div><div class="amount-sub">selected to clean${
      measuring ? `, still measuring ${plural(pending, "item")}` : `, out of ${bytes(t.all)} found`
    }</div></div>
      ${measuring ? '<span class="spinner"></span>' : ""}
      <button class="btn" id="cl-rescan">${icons.refresh}Scan again</button>
      <button class="btn primary big" id="cl-run" ${!t.count || running ? "disabled" : ""}>${running ? '<span class="spinner small"></span>' : t.root ? icons.lock : ""}${
      running ? "Cleaning…" : `Clean ${bytes(t.sel)}`
    }</button>`;
    hero.querySelector("#cl-rescan").onclick = scan;
    hero.querySelector("#cl-run").onclick = run;
  }
  const res = root.querySelector("#cl-result");
  res.innerHTML = lastResult
    ? `<div class="insight ${lastResult.errors.length ? "warn" : "good"}" style="margin-bottom:16px"><span class="stripe"></span><div><strong>${
        lastResult.freed > 0 ? `${bytes(lastResult.freed)} freed.` : "Nothing needed to be removed."
      }</strong><p>${
        lastResult.errors.length
          ? `${plural(lastResult.errors.length, "item")} could not be removed: ${esc(lastResult.errors.slice(0, 3).join("; "))}${lastResult.errors.length > 3 ? "…" : ""}`
          : "Everything you selected was cleaned."
      }</p></div><div></div></div>`
    : "";

  const groups = new Map();
  for (const i of items) {
    if (!groups.has(i.group)) groups.set(i.group, []);
    groups.get(i.group).push(i);
  }
  const body = root.querySelector("#cl-groups");
  if (!scanned) {
    body.innerHTML = `<div class="panel empty"><h3>Find space you can safely get back</h3><p>Clearsight looks at the trash, app caches, developer caches and old system files.</p><button class="btn primary big" id="cl-start">Scan now</button></div>`;
    body.querySelector("#cl-start").onclick = scan;
    return;
  }
  const html = [...groups.entries()]
    .map(([g, list]) => {
      list.sort((a, b) => (b.size ?? -1) - (a.size ?? -1));
      const size = list.reduce((a, i) => a + (i.size || 0), 0);
      const nSel = list.filter((i) => selected.has(i.id)).length;
      const all = nSel === list.length;
      const isOpen = open.has(g);
      return `<div class="panel flush group ${isOpen ? "open" : ""}" data-group="${esc(g)}"><div class="group-head"><input type="checkbox" data-gsel="${esc(g)}" ${all ? "checked" : ""} aria-label="Select all in ${esc(
        g
      )}"><h3>${esc(g)} <span class="muted" style="font-weight:500;font-size:13px">${nSel ? `${nSel} of ${list.length} selected` : plural(list.length, "item")}</span></h3><span class="g-size">${bytes(
        size
      )}</span><svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6-1.4-1.4L12.2 12 7.6 7.4z"/></svg></div><div class="group-body">${
        g === "Other folders in ~/.cache" ? `<div class="group-warning">${esc(GROUP_INFO[g])}</div>` : `<div class="group-warning" style="color:var(--muted);background:none">${esc(GROUP_INFO[g] || "")}</div>`
      }${list
        .map(
          (i) => `<label class="clean-item"><input type="checkbox" data-sel="${esc(i.id)}" ${selected.has(i.id) ? "checked" : ""}><div style="min-width:0"><div class="ci-title">${esc(i.title)} ${
            i.needs_root ? `<span class="badge">${icons.lock}Admin</span>` : ""
          }</div><div class="ci-desc">${esc(i.description)}</div><div class="ci-loc">${esc(i.location)}</div></div>${
            !i.needs_root && i.location && !i.location.includes(" folders in ") ? `<button class="mini-btn ci-open" data-open="${esc(i.location)}" title="Show in file manager">${icons.open}</button>` : "<span></span>"
          }<span class="ci-size">${i.size == null ? '<span class="spinner small"></span>' : bytes(i.size)}</span></label>`
        )
        .join("")}</div></div>`;
    })
    .join("");
  body.innerHTML =
    html +
    `<div class="panel mt row-gap"><div style="flex:1"><b>Need more space?</b><div class="muted" style="font-size:13px">Look for big files and project folders you no longer need.</div></div><button class="btn" id="cl-explore">See what uses space</button></div>`;
  body.querySelector("#cl-explore").onclick = () => go("storage", { tab: "explore", path: store.home });
}

async function run() {
  const chosen = items.filter((i) => selected.has(i.id));
  if (!chosen.length) return;
  const t = totals();
  const unknown = chosen.filter((i) => i.group === "Other folders in ~/.cache");
  const body = `${plural(chosen.length, "item")} will be deleted permanently, freeing about ${bytes(t.sel)}.${
    t.root ? " System items need your administrator password." : ""
  }${unknown.length ? ` ${plural(unknown.length, "folder")} you selected ${unknown.length === 1 ? "is" : "are"} not a known cache: make sure nothing important is inside.` : ""}`;
  const ok = await confirmAction("Clean the selected items?", esc(body), `Clean ${bytes(t.sel)}`, {
    admin: t.root,
    danger: unknown.length > 0,
    list: chosen.slice(0, 40).map((i) => `${i.title}  (${bytes(i.size || 0)})`),
  });
  if (!ok) return;
  running = true;
  render();
  try {
    lastResult = await call("cleanup_run", { ids: chosen.map((i) => i.id) });
    toast(lastResult.freed > 0 ? `${bytes(lastResult.freed)} freed.` : "Nothing needed to be removed.");
  } catch (e) {
    toast(e.message, "bad");
  }
  running = false;
  bus.emit("refresh-storage");
  const keep = lastResult;
  await scan();
  lastResult = keep;
  touched = false;
  render();
}

export default {
  mount(el) {
    root = el;
    root.innerHTML = `<div class="page-head"><div class="titles"><h1>Clean up</h1><p>Free storage in one click. Everything selected by default is safe to remove: apps and tools recreate it when they need it.</p></div></div>
      <div class="panel clean-hero" id="cl-hero"></div><div id="cl-result"></div><div id="cl-groups"></div>`;
    root.addEventListener("click", (e) => {
      const o = e.target.closest("[data-open]");
      if (o) {
        e.preventDefault();
        e.stopPropagation();
        call("open_path", { path: o.dataset.open.replace(/^~/, store.home), reveal: false }).catch((err) => toast(err.message, "bad"));
        return;
      }
      const head = e.target.closest(".group-head");
      if (head && !e.target.closest("input")) {
        const g = head.parentElement.dataset.group;
        open.has(g) ? open.delete(g) : open.add(g);
        head.parentElement.classList.toggle("open");
      }
    });
    root.addEventListener("change", (e) => {
      const t = e.target;
      if (t.dataset.sel) {
        touched = true;
        t.checked ? selected.add(t.dataset.sel) : selected.delete(t.dataset.sel);
        render();
      } else if (t.dataset.gsel) {
        touched = true;
        const list = items.filter((i) => i.group === t.dataset.gsel);
        list.forEach((i) => (t.checked ? selected.add(i.id) : selected.delete(i.id)));
        render();
      }
    });
    render();
  },

  show() {
    if (!scanned) scan();
  },
};
