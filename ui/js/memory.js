import { call, esc, bytes, pct, bar, sparkline, store, toast, confirmAction, appIcon, icons, go } from "./core.js";
import { groupApps, memoryParts } from "./model.js";
import { endTargets } from "./processes.js";

let root;
let running = null;

const COLORS = { apps: "var(--mem)", shared: "#e0709a", cache: "color-mix(in srgb, var(--mem) 35%, var(--panel-2))", free: "transparent" };

function headline(m) {
  const ratio = m.used / m.total;
  if (m.swap_used > m.total * 0.5 || ratio > 0.9) return "Memory is running short.";
  if (ratio > 0.8 || m.swap_used > m.total * 0.2) return "Memory is getting tight.";
  return "You have plenty of memory.";
}

function explain(m) {
  const parts = [`Apps are using ${bytes(m.used)} of your ${bytes(m.total)}. ${bytes(m.available)} is available for new apps.`];
  if (m.swap_used > 256 * 1024 ** 2) {
    parts.push(`Another ${bytes(m.swap_used)} did not fit and was moved to swap, which is much slower than memory.`);
  }
  return parts.join(" ");
}

export default {
  mount(el) {
    root = el;
    root.innerHTML = `<div class="page-head"><div class="titles"><h1 id="mem-title">Memory</h1><p id="mem-sub"></p></div></div>
      <div class="panel"><div id="mem-bar"></div><div class="legend" id="mem-legend"></div></div>
      <div class="grid side mt">
        <div class="panel"><div class="panel-head"><h2>Apps using the most memory</h2><button class="btn small" id="mem-all">All apps</button></div><p class="hint">Memory and swap together. Closing an app gives its memory back right away.</p><div id="mem-top"></div></div>
        <div>
          <div class="panel"><h2>Free up memory</h2><p class="hint">Closing apps you are not using is the most effective step. These tools help in other cases.</p><div class="list" id="mem-actions"></div></div>
          <div class="panel mt"><h2>Swap</h2><p class="hint">Space Linux uses when memory is full.</p><div id="mem-swap"></div></div>
        </div>
      </div>
      <div class="panel mt"><div class="panel-head"><h2>Last two minutes</h2><span class="muted" style="font-size:12.5px"><span style="color:var(--mem)">●</span> Memory in use&nbsp;&nbsp;<span style="color:#e0709a">●</span> Swap in use</span></div><canvas class="chart" id="mem-chart"></canvas></div>`;
    root.querySelector("#mem-all").onclick = () => go("processes", { sort: "mem" });
    root.addEventListener("click", async (e) => {
      const end = e.target.closest("[data-end]");
      if (end) {
        const g = groupApps(store.snap.processes).find((x) => x.key === end.dataset.end);
        if (g) endTargets({ pids: g.procs.map((p) => p.pid), name: g.name, keys: [g.key], own: g.own, app: true, count: g.procs.length }, false);
        return;
      }
      const a = e.target.closest("[data-mem]");
      if (!a || running) return;
      const action = a.dataset.mem;
      if (action === "tmp") {
        go("storage", { tab: "explore", path: "/tmp" });
        return;
      }
      if (action === "drop") {
        const ok = await confirmAction(
          "Clear the file cache?",
          "Linux keeps recently used files in spare memory so they open faster, and hands that memory to apps on its own when they need it. Clearing it frees memory now, but files will open a bit slower for a while.",
          "Clear file cache",
          { admin: true }
        );
        if (!ok) return;
        running = action;
        this.update(store.snap);
        try {
          const freed = await call("drop_caches");
          toast(`File cache cleared. ${bytes(freed)} more memory is available.`);
        } catch (err) {
          toast(err.message, "bad");
        }
      }
      if (action === "swap") {
        const ok = await confirmAction(
          "Move swap back into memory?",
          "Apps whose data was moved to swap will respond faster afterwards. This can take a few minutes, and the computer may feel slow while it works.",
          "Move back into memory",
          { admin: true }
        );
        if (!ok) return;
        running = action;
        this.update(store.snap);
        try {
          const moved = await call("reset_swap");
          toast(`${bytes(moved)} moved back from swap into memory.`);
        } catch (err) {
          toast(err.message, "bad");
        }
      }
      running = null;
      if (store.snap) this.update(store.snap);
    });
  },

  update(s) {
    const m = s.memory;
    const parts = memoryParts(m);
    root.querySelector("#mem-title").textContent = headline(m);
    root.querySelector("#mem-sub").textContent = explain(m);
    const P = (v) => (v / m.total) * 100;
    root.querySelector("#mem-bar").innerHTML = bar(
      [
        { v: P(parts.apps), c: COLORS.apps, t: "Used by apps" },
        { v: P(parts.shared), c: COLORS.shared, t: "Shared and files in memory" },
        { v: P(parts.cache), c: COLORS.cache, t: "Cache" },
      ],
      "huge"
    );
    root.querySelector("#mem-legend").innerHTML = [
      ["Used by apps", parts.apps, COLORS.apps, "Memory programs are actively using."],
      ["Shared and in-memory files", parts.shared, COLORS.shared, "Shared between apps, and files in /tmp or /dev/shm."],
      ["Cache", parts.cache, COLORS.cache, "Recently used files. Given back to apps automatically."],
      ["Free", parts.free, "var(--panel-2)", "Not used at all right now."],
    ]
      .map(
        ([l, v, c, d]) => `<div class="legend-item"><i class="sw" style="background:${c}"></i><div><div class="lg-label">${l}</div><b class="num">${bytes(v)}</b><div class="lg-desc">${d}</div></div></div>`
      )
      .join("");

    const groups = groupApps(s.processes).sort((a, b) => b.mem + b.swap - (a.mem + a.swap));
    const top = groups.slice(0, 10);
    const max = Math.max(1, ...top.map((g) => g.mem + g.swap));
    root.querySelector("#mem-top").innerHTML = `<div class="list">${top
      .map(
        (g) => `<div class="list-row" style="grid-template-columns:22px minmax(0,1fr) auto auto">${appIcon(g.info, g.name)}<div style="min-width:0"><div class="nm">${esc(g.name)}${
          g.procs.length > 1 ? `<span class="muted" style="font-size:12px"> ${g.procs.length} processes</span>` : ""
        }</div>${bar([
          { v: (g.mem / max) * 100, c: "var(--mem)", t: "In memory" },
          { v: (g.swap / max) * 100, c: COLORS.shared, t: "In swap" },
        ])}</div><span class="val num" title="${bytes(g.mem)} in memory, ${bytes(g.swap)} in swap">${bytes(g.mem + g.swap)}</span><button class="btn small danger" data-end="${esc(g.key)}">End</button></div>`
      )
      .join("")}</div>`;

    const biggestSwap = Math.max(0, ...m.swaps.map((x) => x.used));
    const canSwap = m.swap_used > 64 * 1024 ** 2 && m.available > biggestSwap + 768 * 1024 ** 2;
    const tmp = (store.storage?.ram_disks || []).reduce((a, r) => a + r.used, 0);
    const spin = (k) => (running === k ? '<span class="spinner small"></span>' : "");
    const actions = [
      {
        k: "swap",
        title: "Move swap back into memory",
        text:
          m.swap_used < 64 * 1024 ** 2
            ? "Swap is empty, nothing to do."
            : canSwap
            ? `Brings ${bytes(m.swap_used)} back so apps react faster again.`
            : `Not possible right now: ${bytes(m.swap_used)} is in swap but only ${bytes(m.available)} of memory is available. Close some apps first.`,
        disabled: !canSwap,
      },
      {
        k: "drop",
        title: "Clear the file cache",
        text: `Frees up to ${bytes(m.cache)} at once. Rarely needed, Linux does this on its own.`,
        disabled: m.cache < 100 * 1024 ** 2,
      },
    ];
    if (tmp > 50 * 1024 ** 2) {
      actions.push({ k: "tmp", title: "Look at files kept in memory", text: `${bytes(tmp)} of files in /tmp and similar folders live in memory. Deleting them frees it.`, plain: true });
    }
    const html = actions
      .map(
        (a) => `<div class="list-row" style="grid-template-columns:minmax(0,1fr) auto"><div><div style="font-weight:600">${a.title}</div><div class="meta">${esc(a.text)}</div></div><button class="btn small" data-mem="${a.k}" ${
          a.disabled || running ? "disabled" : ""
        }>${spin(a.k)}${a.plain ? "" : icons.lock}${a.k === "tmp" ? "Show files" : a.k === "drop" ? "Clear" : "Move back"}</button></div>`
      )
      .join("");
    const act = root.querySelector("#mem-actions");
    if (act.dataset.html !== html) {
      act.innerHTML = html;
      act.dataset.html = html;
    }

    root.querySelector("#mem-swap").innerHTML = m.swaps.length
      ? m.swaps
          .map((x) => {
            const ratio = x.size ? x.used / x.size : 0;
            const comp = x.compressed && x.original ? `Stores ${bytes(x.original)} compressed into ${bytes(x.compressed)} of real memory.` : "";
            return `<div style="margin-bottom:14px"><div class="row-gap" style="justify-content:space-between"><b>${esc(x.kind)}</b><span class="num">${bytes(x.used)} of ${bytes(x.size)}</span></div>${bar(
              [{ v: ratio * 100, c: ratio > 0.9 ? "var(--bad)" : COLORS.shared }],
              "thick"
            )}<div class="meta muted" style="font-size:12.5px;margin-top:4px">${esc(x.device)}${comp ? ". " + esc(comp) : ""}</div></div>`;
          })
          .join("")
      : `<p class="muted">This computer has no swap.</p>`;

    sparkline(root.querySelector("#mem-chart"), [store.history.mem, store.history.swap], { max: 100, color: ["--mem", "#e0709a"] });
  },
};
