import { call, store, bus, pushHistory, prefs, bytes, pct, bar, levelColor, icons, toast } from "./core.js";
import { ensureAppInfo, mainVolume } from "./model.js";
import overview from "./overview.js";
import processes from "./processes.js";
import memory from "./memory.js";
import storage from "./storage.js";
import cleanup from "./cleanup.js";

const pages = { overview, processes, memory, storage, cleanup };
let current = prefs.get("page", "overview");
let interval = prefs.get("refresh", 2000);
let timer = null;
let busy = false;

for (const [name, mod] of Object.entries(pages)) mod.mount(document.getElementById(`page-${name}`));

function navigate(page, opts) {
  if (!pages[page]) return;
  current = page;
  prefs.set("page", page);
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  document.querySelectorAll(".page").forEach((p) => p.classList.toggle("active", p.id === `page-${page}`));
  pages[page].show?.(opts);
  if (store.snap) pages[page].update?.(store.snap);
}

bus.on("navigate", ({ page, opts }) => navigate(page, opts));
document.querySelectorAll(".nav-item").forEach((b) => (b.onclick = () => navigate(b.dataset.page)));

function renderVitals(s) {
  const m = s.memory;
  const vol = mainVolume();
  const rows = [
    { label: "Processor", value: pct(s.cpu_total), ratio: s.cpu_total / 100, color: "var(--cpu)", page: "processes" },
    { label: "Memory", value: pct((m.used / m.total) * 100), ratio: m.used / m.total, color: "var(--mem)", page: "memory" },
  ];
  if (vol) rows.push({ label: "Main drive", value: `${bytes(vol.avail)} free`, ratio: vol.used / vol.size, color: "var(--disk)", page: "storage" });
  const el = document.getElementById("vitals");
  el.innerHTML = rows
    .map(
      (r) => `<div class="vital" data-page="${r.page}"><span>${r.label}</span><b class="num">${r.value}</b>${bar([
        { v: r.ratio * 100, c: levelColor(r.ratio) || r.color },
      ])}</div>`
    )
    .join("");
  el.querySelectorAll(".vital").forEach((v) => (v.onclick = () => navigate(v.dataset.page)));
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const s = await call("snapshot");
    store.snap = s;
    pushHistory("cpu", s.cpu_total);
    pushHistory("mem", (s.memory.used / s.memory.total) * 100);
    pushHistory("swap", s.memory.swap_total ? (s.memory.swap_used / s.memory.swap_total) * 100 : 0);
    pushHistory("rx", s.net_rx_rate);
    pushHistory("tx", s.net_tx_rate);
    pushHistory("dr", s.disks.reduce((a, d) => a + d.read_rate, 0));
    pushHistory("dw", s.disks.reduce((a, d) => a + d.write_rate, 0));
    const fresh = await ensureAppInfo([...new Set(s.processes.map((p) => p.app))]);
    renderVitals(s);
    pages[current].update?.(s, fresh);
    if (current !== "overview") overview.background?.(s);
  } catch (e) {
    console.error(e);
  } finally {
    busy = false;
  }
}

function schedule() {
  clearInterval(timer);
  timer = null;
  if (interval > 0) timer = setInterval(() => document.visibilityState === "visible" && tick(), interval);
}

export async function refreshStorage() {
  try {
    store.storage = await call("storage");
    bus.emit("storage", store.storage);
    if (store.snap) renderVitals(store.snap);
  } catch (e) {
    toast(e.message, "bad");
  }
}
bus.on("refresh-storage", refreshStorage);

const refreshSel = document.getElementById("refresh");
refreshSel.value = String(interval);
refreshSel.onchange = () => {
  interval = Number(refreshSel.value);
  prefs.set("refresh", interval);
  schedule();
};

const themeBtn = document.getElementById("theme");
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const dark = t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  themeBtn.innerHTML = dark ? icons.sun : icons.moon;
  themeBtn.title = dark ? "Switch to light theme" : "Switch to dark theme";
  if (store.snap) pages[current].update?.(store.snap);
}
applyTheme(prefs.get("theme", null));
themeBtn.onclick = () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  const next = dark ? "light" : "dark";
  prefs.set("theme", next);
  applyTheme(next);
};

document.addEventListener("keydown", (e) => {
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || document.getElementById("dialog").open) return;
  if (!e.ctrlKey && !e.altKey && !e.metaKey && /^[1-5]$/.test(e.key)) {
    navigate(Object.keys(pages)[Number(e.key) - 1]);
    e.preventDefault();
    return;
  }
  pages[current].key?.(e);
});

document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && tick());

(async () => {
  try {
    store.home = await call("home_dir");
  } catch {}
  await refreshStorage();
  await tick();
  navigate(current);
  setTimeout(tick, 700);
  schedule();
  setInterval(refreshStorage, 30000);
})();
