import { call, esc, bytes, rate, pct, icons, appIcon, letterIcon, store, prefs, toast, dialog, confirmAction, ago, dateTime, tildify } from "./core.js";
import { groupApps, displayName } from "./model.js";

let root, tbody, thead, detail, layout, searchInput;
const st = {
  mode: prefs.get("proc.mode", "apps"),
  mine: prefs.get("proc.mine", false),
  sort: prefs.get("proc.sort", { key: "cpu", dir: -1 }),
  search: "",
  expanded: new Set(),
  selected: null,
  pendingScroll: false,
};
let rowsCache = [];

const STATES = {
  R: "Running",
  S: "Waiting (idle)",
  D: "Waiting for the disk",
  Z: "Finished, waiting for its parent (zombie)",
  T: "Paused",
  t: "Paused by a debugger",
  I: "Idle",
  X: "Exiting",
};

const CRITICAL = new Set([
  "systemd", "Xorg", "Xwayland", "cinnamon", "cinnamon-session-binary", "gnome-shell", "gnome-session-binary", "plasmashell",
  "kwin_x11", "kwin_wayland", "ksmserver", "xfce4-session", "xfwm4", "mutter", "dbus-daemon", "dbus-broker", "lightdm", "gdm",
  "gdm3", "sddm", "pipewire", "wireplumber", "NetworkManager", "polkitd", "systemd-logind", "Xorg.wrap", "muffin", "csd-power",
]);

const COLS = () => {
  const c = [
    { key: "name", label: "Name", width: "auto" },
    { key: "cpu", label: "Processor", width: "110px" },
    { key: "mem", label: "Memory", width: "120px" },
    { key: "swap", label: "In swap", width: "110px" },
    { key: "disk", label: "Disk", width: "110px" },
  ];
  if (st.mode === "all") {
    c.push({ key: "pid", label: "PID", width: "84px" }, { key: "user", label: "User", width: "110px" });
  } else {
    c.push({ key: "count", label: "Processes", width: "96px" });
  }
  return c;
};

function sortVal(r, key) {
  switch (key) {
    case "name": return r.name.toLowerCase();
    case "cpu": return r.cpu;
    case "mem": return r.mem;
    case "swap": return r.swap;
    case "disk": return r.read + r.write;
    case "pid": return r.pid;
    case "user": return r.user;
    case "count": return r.count;
  }
  return 0;
}

function build(s) {
  const q = st.search.trim().toLowerCase();
  let rows;
  if (st.mode === "apps") {
    rows = groupApps(s.processes, { mineOnly: st.mine }).map((g) => ({
      type: "app",
      id: g.key,
      name: g.name,
      info: g.info,
      cpu: g.cpu,
      mem: g.mem,
      swap: g.swap,
      read: g.read,
      write: g.write,
      count: g.procs.length,
      paused: g.paused,
      user: [...g.users].join(", "),
      procs: g.procs,
      group: g,
    }));
    if (q) {
      rows = rows.filter(
        (r) => r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q) || r.procs.some((p) => String(p.pid) === q || p.cmd.toLowerCase().includes(q))
      );
    }
  } else {
    rows = s.processes
      .filter((p) => !st.mine || p.own)
      .map((p) => ({
        type: "proc",
        id: p.pid,
        pid: p.pid,
        name: p.name,
        info: store.apps[p.app],
        appName: displayName(p.app),
        cpu: p.cpu,
        mem: p.mem,
        swap: p.swap,
        read: p.read_rate,
        write: p.write_rate,
        user: p.user,
        paused: p.state === "T",
        proc: p,
      }));
    if (q) {
      rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.appName.toLowerCase().includes(q) || String(r.pid) === q || r.proc.cmd.toLowerCase().includes(q));
    }
  }
  const { key, dir } = st.sort;
  rows.sort((a, b) => {
    const va = sortVal(a, key);
    const vb = sortVal(b, key);
    if (va < vb) return -dir;
    if (va > vb) return dir;
    return b.mem - a.mem;
  });
  return rows;
}

function heat(v, max, color) {
  const w = max > 0 ? Math.min(100, (v / max) * 100) : 0;
  if (w < 0.5) return "";
  const a = Math.min(30, 5 + w * 0.35);
  return `style="background:color-mix(in srgb, ${color} ${a.toFixed(0)}%, transparent)"`;
}

function procLabel(p) {
  const args = p.cmd.split(" ").slice(1).join(" ");
  return args ? `${p.name}  ${args.length > 90 ? args.slice(0, 90) + "…" : args}` : p.name;
}

function renderHead(s) {
  const m = s.memory;
  const totals = {
    cpu: pct(s.cpu_total),
    mem: `${Math.round((m.used / m.total) * 100)}%`,
    swap: m.swap_total ? bytes(m.swap_used) : "–",
    disk: rate(s.disks.reduce((a, d) => a + d.read_rate + d.write_rate, 0)),
  };
  thead.innerHTML = `<tr>${COLS()
    .map((c) => {
      const sorted = st.sort.key === c.key;
      return `<th data-key="${c.key}" style="width:${c.width}" class="${sorted ? "sorted " + (st.sort.dir < 0 ? "desc" : "asc") : ""}">${
        totals[c.key] ? `<span class="total num">${totals[c.key]}</span>` : ""
      }${c.label}</th>`;
    })
    .join("")}</tr>`;
}

let hovering = false;
let lastOrder = new Map();

function renderBody(s, resort) {
  const rows = build(s);
  if (hovering && !resort && lastOrder.size) {
    const pos = (r) => lastOrder.get(r.type + r.id) ?? 1e9;
    rows.sort((a, b) => pos(a) - pos(b));
  }
  lastOrder = new Map(rows.map((r, i) => [r.type + r.id, i]));
  rowsCache = rows;
  const m = s.memory;
  const ioMax = Math.max(1, ...rows.map((r) => r.read + r.write));
  const swapMax = Math.max(1, m.swap_total);
  const out = [];
  const sel = st.selected;
  for (const r of rows) {
    const isSel = sel && sel.type === r.type && sel.id === r.id;
    const disk = r.read + r.write;
    const cells = `<td ${heat(r.cpu, 100, "var(--cpu)")}>${pct(r.cpu, 1)}</td><td ${heat(r.mem, m.total, "var(--mem)")}>${bytes(r.mem)}</td><td ${heat(
      r.swap,
      swapMax,
      "var(--mem)"
    )}>${r.swap ? bytes(r.swap) : "–"}</td><td ${heat(disk, ioMax, "var(--disk)")}>${disk ? rate(disk) : "–"}</td>`;
    if (r.type === "app") {
      const open = st.expanded.has(r.id);
      out.push(
        `<tr class="row app${isSel ? " selected" : ""}" data-type="app" data-id="${esc(r.id)}"><td><div class="name-cell"><button class="tw${r.count > 1 ? (open ? " open" : "") : " none"}" data-toggle="1" aria-label="Show processes">${icons.chevron}</button>${appIcon(
          r.info,
          r.name
        )}<span class="nm" title="${esc(r.id)}">${esc(r.name)}</span>${r.paused ? '<span class="paused">Paused</span>' : ""}</div></td>${cells}<td>${r.count}</td></tr>`
      );
      if (open && r.count > 1) {
        for (const p of r.procs.slice(0, 200)) {
          const cs = sel && sel.type === "proc" && sel.id === p.pid;
          const pd = p.read_rate + p.write_rate;
          out.push(
            `<tr class="row child${cs ? " selected" : ""}" data-type="proc" data-id="${p.pid}"><td title="${esc(p.cmd)}">${esc(procLabel(p))}</td><td>${pct(p.cpu, 1)}</td><td>${bytes(p.mem)}</td><td>${
              p.swap ? bytes(p.swap) : "–"
            }</td><td>${pd ? rate(pd) : "–"}</td><td>${p.pid}</td></tr>`
          );
        }
      }
    } else {
      out.push(
        `<tr class="row${isSel ? " selected" : ""}" data-type="proc" data-id="${r.pid}"><td><div class="name-cell">${appIcon(r.info, r.appName)}<span class="nm" title="${esc(
          r.proc.cmd || r.name
        )}">${esc(r.name)}</span>${r.paused ? '<span class="paused">Paused</span>' : ""}</div></td>${cells}<td>${r.pid}</td><td>${esc(r.user)}</td></tr>`
      );
    }
  }
  if (!rows.length) {
    out.push(`<tr><td colspan="${COLS().length}"><div class="empty"><h3>Nothing matches “${esc(st.search)}”</h3><p>Try part of the app name, a command or a process ID.</p></div></td></tr>`);
  }
  tbody.innerHTML = out.join("");
  if (st.pendingScroll) {
    st.pendingScroll = false;
    tbody.querySelector("tr.selected")?.scrollIntoView({ block: "center" });
  }
}

function findSelected(s) {
  const sel = st.selected;
  if (!sel) return null;
  if (sel.type === "app") {
    const g = groupApps(s.processes).find((x) => x.key === sel.id);
    return g ? { type: "app", g } : null;
  }
  const p = s.processes.find((x) => x.pid === sel.id);
  return p ? { type: "proc", p } : null;
}

function renderDetail(s) {
  const found = findSelected(s);
  layout.classList.toggle("with-detail", !!found);
  if (!found) {
    detail.innerHTML = "";
    return;
  }
  let html;
  if (found.type === "app") {
    const g = found.g;
    const exe = g.procs.find((p) => p.exe)?.exe;
    const minNice = Math.min(...g.procs.map((p) => p.nice));
    html = `<div class="d-head">${appIcon(g.info, g.name)}<div><h2>${esc(g.name)}</h2><div class="sub">${g.procs.length === 1 ? "1 process" : g.procs.length + " processes"}, started ${ago(
      g.started
    )}</div></div><button class="icon-btn close" data-act="close" aria-label="Close details">${icons.close}</button></div>
      <div class="d-stats"><div class="d-stat"><span>Processor</span><b class="num">${pct(g.cpu, 1)}</b></div><div class="d-stat"><span>Memory</span><b class="num">${bytes(g.mem)}</b></div><div class="d-stat"><span>In swap</span><b class="num">${bytes(
      g.swap
    )}</b></div><div class="d-stat"><span>Disk</span><b class="num">${rate(g.read + g.write)}</b></div></div>
      <div class="d-actions"><button class="btn danger" data-act="term">${icons.stop}End app</button><button class="btn danger" data-act="kill">Force quit</button>${
        g.paused ? `<button class="btn" data-act="cont">${icons.play}Resume</button>` : `<button class="btn" data-act="stop">${icons.pause}Pause</button>`
      }${minNice > 0 ? `<button class="btn" data-act="normal">Normal priority</button>` : `<button class="btn" data-act="lower">Lower priority</button>`}${
        exe ? `<button class="btn" data-act="reveal" data-path="${esc(exe)}" style="grid-column:1/-1">${icons.open}Open program folder</button>` : ""
      }</div>
      <dl><dt>Program</dt><dd>${esc(exe || g.key)}</dd><dt>User</dt><dd>${esc([...g.users].join(", "))}</dd><dt>Threads</dt><dd>${g.threads}</dd><dt>Started</dt><dd>${esc(
      dateTime(g.started)
    )}</dd><dt>Process IDs</dt><dd>${g.procs
      .slice(0, 40)
      .map((p) => p.pid)
      .join(", ")}${g.procs.length > 40 ? "…" : ""}</dd><dt>Command</dt><dd>${esc(g.procs[0]?.cmd || "")}</dd></dl>`;
  } else {
    const p = found.p;
    const name = displayName(p.app);
    html = `<div class="d-head">${appIcon(store.apps[p.app], name)}<div><h2>${esc(p.name)}</h2><div class="sub">Part of ${esc(name)}, process ${p.pid}</div></div><button class="icon-btn close" data-act="close" aria-label="Close details">${
      icons.close
    }</button></div>
      <div class="d-stats"><div class="d-stat"><span>Processor</span><b class="num">${pct(p.cpu, 1)}</b></div><div class="d-stat"><span>Memory</span><b class="num">${bytes(p.mem)}</b></div><div class="d-stat"><span>In swap</span><b class="num">${bytes(
      p.swap
    )}</b></div><div class="d-stat"><span>Disk</span><b class="num">${rate(p.read_rate + p.write_rate)}</b></div></div>
      <div class="d-actions"><button class="btn danger" data-act="term">${icons.stop}End process</button><button class="btn danger" data-act="kill">Force quit</button>${
        p.state === "T" ? `<button class="btn" data-act="cont">${icons.play}Resume</button>` : `<button class="btn" data-act="stop">${icons.pause}Pause</button>`
      }${p.nice > 0 ? `<button class="btn" data-act="normal">Normal priority</button>` : `<button class="btn" data-act="lower">Lower priority</button>`}${
        p.exe ? `<button class="btn" data-act="reveal" data-path="${esc(p.exe)}" style="grid-column:1/-1">${icons.open}Open program folder</button>` : ""
      }</div>
      <dl><dt>State</dt><dd>${esc(STATES[p.state] || p.state)}</dd><dt>User</dt><dd>${esc(p.user)}</dd><dt>Parent</dt><dd>${p.ppid}</dd><dt>Threads</dt><dd>${p.threads}</dd><dt>Priority</dt><dd>${
      p.nice === 0 ? "Normal" : p.nice > 0 ? `Lower (${p.nice})` : `Higher (${p.nice})`
    }</dd><dt>Memory (resident)</dt><dd>${bytes(p.rss)}</dd><dt>Started</dt><dd>${esc(dateTime(p.started))}</dd><dt>Program</dt><dd>${esc(p.exe || "Not readable")}</dd><dt>Command</dt><dd>${esc(
      p.cmd || p.name
    )}</dd></dl>`;
  }
  if (detail.dataset.html !== html) {
    detail.innerHTML = html;
    detail.dataset.html = html;
  }
}

function targets() {
  const found = store.snap && findSelected(store.snap);
  if (!found) return null;
  if (found.type === "app") {
    const g = found.g;
    return { pids: g.procs.map((p) => p.pid), name: g.name, keys: [g.key, ...g.procs.map((p) => p.name)], own: g.own, app: true, count: g.procs.length };
  }
  return { pids: [found.p.pid], name: `${found.p.name} (${found.p.pid})`, keys: [found.p.app, found.p.name], own: found.p.own, app: false, count: 1 };
}

async function signalWithFallback(t, sig, verb) {
  const res = await call("signal", { pids: t.pids, sig });
  if (res.denied.length) {
    const ok = await confirmAction(
      `${verb} needs your password`,
      `${esc(t.name)} belongs to another user or to the system. Enter the administrator password to continue.`,
      `${verb} as administrator`,
      { danger: sig === "term" || sig === "kill", admin: true }
    );
    if (!ok) return false;
    await call("signal_as_admin", { pids: res.denied, sig });
  }
  return true;
}

export async function endTargets(t, force) {
  if (!t) return;
  const critical = t.keys.some((k) => CRITICAL.has(k));
  const what = t.app ? (t.count > 1 ? `All ${t.count} processes of ${esc(t.name)} will` : `${esc(t.name)} will`) : `This process will`;
  const body = force
    ? `${what} be stopped immediately. Unsaved work in it will be lost.`
    : `${what} be asked to close, like clicking its close button. Save your work in it first.`;
  const warn = critical ? `<p class="warn-text"><b>This is part of your desktop or system.</b> Ending it can log you out or make the computer stop responding.</p>` : "";
  const ok = await dialog({
    title: force ? `Force quit ${t.name}?` : `End ${t.name}?`,
    body: `<p>${body}</p>${warn}`,
    buttons: [
      { label: "Cancel", value: false },
      { label: force ? "Force quit" : t.app ? "End app" : "End process", value: true, cls: "danger solid" },
    ],
  });
  if (!ok) return;
  try {
    if (await signalWithFallback(t, force ? "kill" : "term", force ? "Force quit" : "Ending")) {
      toast(force ? `${t.name} was force quit.` : `${t.name} was asked to close.`);
      if (!force) {
        setTimeout(async () => {
          const s = await call("snapshot").catch(() => null);
          if (!s) return;
          const left = s.processes.filter((p) => t.pids.includes(p.pid));
          if (left.length) {
            const again = await confirmAction(`${t.name} is still running`, "It did not close on its own. Force it to quit? Unsaved work will be lost.", "Force quit", { danger: true });
            if (again) {
              await signalWithFallback({ ...t, pids: left.map((p) => p.pid) }, "kill", "Force quit");
              toast(`${t.name} was force quit.`);
            }
          }
        }, 4000);
      }
    }
  } catch (e) {
    toast(e.message, "bad");
  }
}

async function act(action, el) {
  const t = targets();
  try {
    switch (action) {
      case "close":
        st.selected = null;
        renderDetail(store.snap);
        renderBody(store.snap);
        return;
      case "term":
      case "kill":
        await endTargets(t, action === "kill");
        return;
      case "stop":
        if (await signalWithFallback(t, "stop", "Pausing")) toast(`${t.name} is paused. It keeps its memory and stops using the processor until you resume it.`);
        return;
      case "cont":
        if (await signalWithFallback(t, "cont", "Resuming")) toast(`${t.name} is running again.`);
        return;
      case "lower":
        await call("set_priority", { pids: t.pids, nice: 10 });
        toast(`${t.name} now gets less processor time when other apps need it.`);
        return;
      case "normal":
        await call("set_priority", { pids: t.pids, nice: 0 });
        toast(`${t.name} is back to normal priority.`);
        return;
      case "reveal":
        await call("open_path", { path: el.dataset.path, reveal: true });
        return;
    }
  } catch (e) {
    toast(e.message, "bad");
  }
}

function select(type, id, scroll) {
  st.selected = { type, id };
  st.pendingScroll = !!scroll;
  if (store.snap) {
    renderBody(store.snap);
    renderDetail(store.snap);
  }
}

export default {
  mount(el) {
    root = el;
    root.classList.add("fill");
    root.innerHTML = `<div class="page-head"><div class="titles"><h1>Apps &amp; processes</h1><p id="pr-summary">Everything running on your computer.</p></div>
      <div class="tools"><div class="search">${icons.search}<input id="pr-search" type="search" placeholder="Search apps or commands" aria-label="Search"></div>
      <div class="seg" role="tablist"><button data-mode="apps">Apps</button><button data-mode="all">All processes</button></div>
      <label class="check"><input type="checkbox" id="pr-mine"> Only mine</label></div></div>
      <div class="proc-layout"><div class="table-wrap"><table class="data"><thead></thead><tbody></tbody></table></div><aside class="panel detail"></aside></div>`;
    tbody = root.querySelector("tbody");
    thead = root.querySelector("thead");
    detail = root.querySelector(".detail");
    layout = root.querySelector(".proc-layout");
    searchInput = root.querySelector("#pr-search");
    const segs = root.querySelectorAll(".seg button");
    const syncSeg = () => segs.forEach((b) => b.classList.toggle("on", b.dataset.mode === st.mode));
    syncSeg();
    segs.forEach(
      (b) =>
        (b.onclick = () => {
          st.mode = b.dataset.mode;
          prefs.set("proc.mode", st.mode);
          if (st.mode === "apps" && ["pid", "user"].includes(st.sort.key)) st.sort = { key: "cpu", dir: -1 };
          if (st.mode === "all" && st.sort.key === "count") st.sort = { key: "cpu", dir: -1 };
          syncSeg();
          this.update(store.snap);
        })
    );
    const mine = root.querySelector("#pr-mine");
    mine.checked = st.mine;
    mine.onchange = () => {
      st.mine = mine.checked;
      prefs.set("proc.mine", st.mine);
      this.update(store.snap);
    };
    searchInput.oninput = () => {
      st.search = searchInput.value;
      renderBody(store.snap, true);
    };
    thead.onclick = (e) => {
      const th = e.target.closest("th");
      if (!th) return;
      const key = th.dataset.key;
      st.sort = st.sort.key === key ? { key, dir: -st.sort.dir } : { key, dir: key === "name" || key === "user" || key === "pid" ? 1 : -1 };
      prefs.set("proc.sort", st.sort);
      lastOrder = new Map();
      this.update(store.snap);
    };
    const wrap = root.querySelector(".table-wrap");
    wrap.addEventListener("mouseenter", () => (hovering = true));
    wrap.addEventListener("mouseleave", () => (hovering = false));
    tbody.addEventListener("mousedown", (e) => {
      const tr = e.target.closest("tr.row");
      if (!tr) return;
      if (e.target.closest("[data-toggle]")) {
        const id = tr.dataset.id;
        st.expanded.has(id) ? st.expanded.delete(id) : st.expanded.add(id);
        renderBody(store.snap);
        return;
      }
      const type = tr.dataset.type;
      select(type, type === "app" ? tr.dataset.id : Number(tr.dataset.id));
    });
    tbody.addEventListener("dblclick", (e) => {
      const tr = e.target.closest("tr.row.app");
      if (!tr) return;
      const id = tr.dataset.id;
      st.expanded.has(id) ? st.expanded.delete(id) : st.expanded.add(id);
      renderBody(store.snap);
    });
    detail.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (b) act(b.dataset.act, b);
    });
  },

  show(opts = {}) {
    if (opts.sort) st.sort = { key: opts.sort, dir: -1 };
    if (opts.select) {
      st.mode = "apps";
      root.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === "apps"));
      st.search = "";
      searchInput.value = "";
      st.selected = { type: "app", id: opts.select };
      st.pendingScroll = true;
    }
  },

  update(s) {
    if (!s) return;
    renderHead(s);
    renderBody(s);
    renderDetail(s);
    const groups = groupApps(s.processes);
    root.querySelector("#pr-summary").textContent = `${groups.length} apps running as ${s.processes.length} processes. Select a row for details and actions.`;
  },

  key(e) {
    if ((e.ctrlKey && e.key === "f") || e.key === "/") {
      searchInput.focus();
      searchInput.select();
      e.preventDefault();
      return;
    }
    if (e.key === "Escape") {
      if (st.selected) act("close");
      return;
    }
    if (e.key === "Delete" && st.selected) {
      endTargets(targets(), e.shiftKey);
      e.preventDefault();
      return;
    }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && rowsCache.length) {
      const flat = [...tbody.querySelectorAll("tr.row")];
      let idx = flat.findIndex((tr) => tr.classList.contains("selected"));
      idx = e.key === "ArrowDown" ? Math.min(flat.length - 1, idx + 1) : Math.max(0, idx - 1);
      const tr = flat[idx];
      if (tr) {
        select(tr.dataset.type, tr.dataset.type === "app" ? tr.dataset.id : Number(tr.dataset.id));
        tbody.querySelector("tr.selected")?.scrollIntoView({ block: "nearest" });
      }
      e.preventDefault();
      return;
    }
    if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && st.selected?.type === "app") {
      e.key === "ArrowRight" ? st.expanded.add(st.selected.id) : st.expanded.delete(st.selected.id);
      renderBody(store.snap);
      e.preventDefault();
    }
  },
};
