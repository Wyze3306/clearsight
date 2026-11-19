import { call, esc, bytes, bar, levelColor, store, toast, dialog, confirmAction, icons, bus, plural, tildify, dateTime, prefs } from "./core.js";
import { mainVolume } from "./model.js";

let root;
let tab = "drives";
let sub = "folders";
let scanTimer = null;
let current = null;
let lastStatus = null;
let pendingPath = null;

const PART_COLORS = ["#4f7cff", "#9b5cf0", "#1f9d8b", "#d6a400", "#d94a8c", "#3a9e4f", "#c2662d"];

const LAYER_ICON = {
  disk: '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4zm3 3v2h10V7z"/></svg>',
  part: '<svg viewBox="0 0 24 24"><path d="M4 4h7v16H4zm9 0h7v16h-7z"/></svg>',
  lvm: '<svg viewBox="0 0 24 24"><path d="M3 5h18v4H3zm0 5h18v4H3zm0 5h18v4H3z"/></svg>',
  crypt: icons.lock,
  raid: '<svg viewBox="0 0 24 24"><path d="M3 5h8v14H3zm10 0h8v14h-8z"/></svg>',
  fs: icons.folder,
};

function explainPath(path, name) {
  const h = store.home;
  const rel = h && path.startsWith(h + "/") ? path.slice(h.length + 1) : null;
  const homeMap = {
    ".cache": "App caches. Clean them safely from Clean up.",
    ".local": "App data and settings",
    ".local/share": "App data",
    ".local/share/Trash": "Trash. Empty it from Clean up.",
    ".local/share/Steam": "Steam and its games",
    ".local/share/flatpak": "Flatpak apps installed for you",
    ".local/share/containers": "Podman containers and images",
    ".var": "Flatpak app data",
    ".var/app": "Data of each Flatpak app",
    ".config": "App settings. Keep this.",
    ".cargo": "Rust tools and downloaded crates",
    ".cargo/registry": "Downloaded Rust crates. Clean them from Clean up.",
    ".local/share/Steam/steamapps": "Installed Steam games",
    ".local/share/Trash/files": "Trash",
    ".rustup": "Rust toolchains",
    ".npm": "npm download cache",
    ".nvm": "Node.js versions (nvm)",
    ".gradle": "Gradle cache and versions",
    ".m2": "Maven libraries",
    ".nuget": ".NET packages",
    ".wine": "Windows programs (Wine)",
    ".android": "Android SDK data",
    ".mozilla": "Firefox profile",
    snap: "Snap app data",
    ".steam": "Steam",
    ".minecraft": "Minecraft",
    Downloads: "Downloads",
    "Téléchargements": "Downloads",
    Videos: "Videos",
    "Vidéos": "Videos",
  };
  if (rel && homeMap[rel]) return homeMap[rel];
  const sys = {
    "/home/.ecryptfs": "Encrypted copy of your home folder. Its real files are counted in your home folder instead.",
    "/usr": "Installed software",
    "/opt": "Software installed outside the package manager",
    "/var": "System data, logs and caches",
    "/var/lib/flatpak": "Flatpak apps",
    "/var/lib/docker": "Docker images and containers",
    "/var/lib/snapd": "Snap apps",
    "/var/log": "System logs",
    "/var/cache/apt": "Downloaded packages. Clean them from Clean up.",
    "/var/lib/libvirt": "Virtual machines",
    "/swapfile": "Swap file. Linux needs it, do not delete.",
    "/tmp": "Temporary files",
    "/boot": "Linux kernels",
    "/snap": "Snap apps",
  };
  if (sys[path]) return sys[path];
  if (lastStatus?.decrypted?.includes(path)) return "Your personal files, read through the encryption";
  if (path.startsWith("/home/.ecryptfs/")) return "Encrypted copy of your home folder. Its real files are shown in your home folder instead.";
  if (name === "node_modules") return "Node.js packages. npm install restores them.";
  if (name === ".git") return "Version history of this project";
  if (name === "__pycache__") return "Python bytecode cache";
  if (/^\.?venv$/.test(name)) return "Python virtual environment";
  return "";
}

function chain(layers) {
  return `<div class="chain">${layers
    .map((l) => `<span class="chip ${l.kind === "crypt" ? "crypt" : ""}" title="${esc(l.name)}">${LAYER_ICON[l.kind] || ""}<b>${esc(l.kind === "fs" ? l.name : l.kind === "crypt" ? "Encrypted" : l.name)}</b> ${esc(l.detail)}</span>`)
    .join('<span class="arrow">›</span>')}</div>`;
}

let breakdowns = prefs.get("breakdowns", {});

function legendRow(items) {
  return `<div class="legend" style="grid-column:1/-1;margin-top:10px">${items
    .filter((i) => i.v > 0)
    .map((i) => `<div class="legend-item"><i class="sw" style="background:${i.c}"></i><div><div class="lg-label">${i.l}</div><b class="num">${bytes(i.v)}</b></div></div>`)
    .join("")}</div>`;
}

function volumeHtml(v, info) {
  const ratio = v.size ? v.used / v.size : 0;
  const children = info.volumes.filter((o) => o.backed_by === v.mount);
  const badges = [];
  if (v.encryption) badges.push(`<span class="badge good">${icons.shield}${esc(v.encryption)}</span>`);
  if (children.some((c) => c.encryption)) badges.push(`<span class="badge good">${icons.shield}Holds your encrypted home folder</span>`);
  if (v.removable) badges.push(`<span class="badge">External</span>`);
  if (v.role === "boot") badges.push(`<span class="badge">Needed to start Linux</span>`);
  const freeRatio = v.size ? v.avail / v.size : 1;
  if (v.role !== "boot" && (freeRatio < 0.05 || (v.avail < 5 * 1024 ** 3 && v.size > 20 * 1024 ** 3))) badges.push(`<span class="badge bad">Almost full</span>`);
  else if (v.role !== "boot" && freeRatio < 0.12) badges.push(`<span class="badge warn">Getting full</span>`);

  const bd = breakdowns[v.mount];
  let usage;
  if (bd && children.length) {
    const home = Math.min(bd.home, v.used);
    const system = Math.min(bd.system, Math.max(0, v.used - home));
    const other = Math.max(0, v.used - home - system);
    const P = (x) => (x / v.size) * 100;
    usage =
      bar(
        [
          { v: P(home), c: "var(--accent)", t: "Your files" },
          { v: P(system), c: "var(--disk)", t: "Apps and system" },
          { v: P(other), c: "var(--faint)", t: "Other" },
          { v: P(v.reserved), c: "var(--line-strong)", t: "Reserved" },
        ],
        "thick"
      ) +
      legendRow([
        { l: "Your files", v: home, c: "var(--accent)" },
        { l: "Apps and system", v: system, c: "var(--disk)" },
        { l: "Encryption overhead and unreadable", v: other, c: "var(--faint)" },
        { l: "Reserved by ext4", v: v.reserved, c: "var(--line-strong)" },
        { l: "Free", v: v.avail, c: "var(--panel-2)" },
      ]) +
      `<div class="muted" style="grid-column:1/-1;font-size:12px">Measured ${esc(dateTime(bd.at))}.</div>`;
  } else {
    usage = bar([{ v: ratio * 100, c: levelColor(ratio) || "var(--disk)" }], "thick");
  }

  let notes = "";
  for (const c of children) {
    notes += `<div class="note row-gap" style="justify-content:space-between"><span><b>${esc(c.label)}</b> (${esc(c.mount)}) is on this drive${
      c.encryption ? `, encrypted with eCryptfs and unlocked. Clearsight shows its real files, not the encrypted copy` : ""
    }.</span><span class="row-gap"><button class="btn small" data-open="${esc(c.mount)}">${icons.open}Open</button><button class="btn small" data-explore="${esc(
      c.mount
    )}">See what uses space</button></span></div>`;
  }
  if (children.length && !bd) {
    notes += `<div class="note row-gap" style="justify-content:space-between"><span>Measure the whole drive to see how much is your files and how much is apps and system.</span><button class="btn small primary" data-explore="${esc(
      v.mount
    )}">Measure this drive</button></div>`;
  }
  if (v.can_reduce_reserved) {
    const gain = v.reserved - v.size * 0.01;
    notes += `<div class="note row-gap" style="justify-content:space-between"><span><b>${bytes(v.reserved)} is held in reserve</b> by the ext4 file system for emergencies (5% of the drive). Lowering it to 1% gives you about ${bytes(
      gain
    )} more free space and is safe on large drives.</span><button class="btn small" data-reserve="${esc(v.device)}">${icons.lock}Lower to 1%</button></div>`;
  }
  return `<div class="volume"><div><div class="v-name">${esc(children.length && v.role === "system" ? "System drive" : v.label)} ${badges.join(" ")}</div><div class="v-mount">${esc(v.mount)}, ${esc(
    v.fstype
  )}</div></div>
    <div class="v-free"><b class="num">${bytes(v.avail)}</b><span>free of ${bytes(v.size)}</span></div>
    ${usage}
    <div class="v-foot"><span>${bytes(v.used)} used${v.reserved > 0 && !v.can_reduce_reserved && v.reserved > v.size * 0.004 ? `, ${bytes(v.reserved)} reserved` : ""}</span><span class="spacer"></span>
    <button class="btn small" data-open="${esc(v.mount)}">${icons.open}Open</button><button class="btn small primary" data-explore="${esc(v.role === "home" ? store.home : v.mount)}">See what uses space</button></div>
    <div style="grid-column:1/-1">${chain(v.layers)}</div>${notes}</div>`;
}

async function recordBreakdown(status) {
  const info = store.storage;
  const vol = info?.volumes.find((v) => v.mount === status.root);
  if (!vol || !status.decrypted?.length) return;
  try {
    const l = await call("scan_list", { path: status.root });
    let home = 0;
    for (const d of status.decrypted) {
      const rel = d.slice(status.root === "/" ? 1 : status.root.length + 1).split("/");
      let path = status.root;
      let size = null;
      for (const part of rel) {
        const list = await call("scan_list", { path });
        const hit = list.entries.find((e) => e.name === part && e.is_dir);
        if (!hit) break;
        path = hit.path;
        size = hit.size;
      }
      if (size != null) home += size;
    }
    breakdowns[status.root] = { home, system: Math.max(0, l.size - home), at: Date.now() / 1000 };
    prefs.set("breakdowns", breakdowns);
    renderDrives();
  } catch {}
}

function disksHtml(info) {
  return info.disks
    .map((d) => {
      const top = d.parts.filter((p) => p.depth === 1);
      const segs = top.map((p, i) => ({ p, c: PART_COLORS[i % PART_COLORS.length], w: (p.size / d.size) * 100 }));
      const used = top.reduce((a, p) => a + p.size, 0);
      const free = d.size - used;
      return `<div class="panel mb"><div class="row-gap" style="justify-content:space-between"><div><h2 style="margin:0">${esc(d.model)}</h2><div class="muted" style="font-size:12.5px">${esc(d.kind)}, /dev/${esc(
        d.name
      )}</div></div><b class="num" style="font-size:17px">${bytes(d.size)}</b></div>
      <div class="diskmap">${segs
        .map((s) => `<div style="flex:${Math.max(s.w, 0.6)};background:${s.c}" title="${esc(s.p.name)}: ${esc(s.p.role)}">${s.w > 9 ? esc(s.p.label || s.p.name) : ""}</div>`)
        .join("")}${free > d.size * 0.01 ? `<div style="flex:${(free / d.size) * 100};background:var(--panel-2);color:var(--muted)">${(free / d.size) * 100 > 9 ? "Unallocated" : ""}</div>` : ""}</div>
      <div class="parts">${d.parts
        .map((p) => {
          const i = top.indexOf(p);
          const sw = i >= 0 ? `<span class="sw" style="background:${PART_COLORS[i % PART_COLORS.length]}"></span>` : `<span></span>`;
          return `<div class="p" style="padding-left:${(p.depth - 1) * 18}px">${sw}<span><b>${esc(p.label || p.name)}</b> ${esc(p.role)}${p.fstype && !p.role.includes(p.fstype) ? `, ${esc(p.fstype)}` : ""}</span><span class="num">${bytes(
            p.size
          )}</span></div>`;
        })
        .join("")}</div></div>`;
    })
    .join("");
}

function renderDrives() {
  const info = store.storage;
  const el = root.querySelector("#st-drives");
  if (!info) {
    el.innerHTML = `<div class="empty"><div class="spinner" style="margin:auto"></div></div>`;
    return;
  }
  const vols = info.volumes;
  const shown = vols.filter((v) => v.role !== "boot" && !(v.backed_by && vols.some((o) => o.mount === v.backed_by)));
  const boot = vols.filter((v) => v.role === "boot");
  el.innerHTML = `<div class="panel flush">${shown.map((v) => volumeHtml(v, info)).join("")}</div>
    ${boot.length ? `<p class="muted mt" style="font-size:12.5px">Also mounted: ${boot.map((b) => `${esc(b.label)} (${esc(b.mount)}, ${bytes(b.used)} of ${bytes(b.size)})`).join(", ")}.</p>` : ""}
    <h2 class="section-title">Physical drives</h2>${disksHtml(info)}
    ${
      info.ram_disks.length
        ? `<h2 class="section-title">Folders kept in memory</h2><div class="panel"><p class="hint">These folders live in RAM, not on a drive. Files in them use memory until deleted or until you restart.</p><div class="list">${info.ram_disks
            .map(
              (r) =>
                `<div class="list-row" style="grid-template-columns:minmax(0,1fr) auto auto"><span class="nm">${esc(r.mount)}</span><span class="val num">${bytes(r.used)}</span><button class="btn small" data-explore="${esc(r.mount)}">Look inside</button></div>`
            )
            .join("")}</div></div>`
        : ""
    }`;
  const main = mainVolume();
  root.querySelector("#st-sub").textContent = main ? `${main.label}: ${bytes(main.avail)} free of ${bytes(main.size)}.` : "Your drives and what is on them.";
}

function places() {
  const info = store.storage;
  const list = [{ path: store.home, label: "Home folder", detail: "~" }];
  for (const v of info?.volumes || []) {
    if (v.role === "home" || v.role === "boot") continue;
    list.push({ path: v.mount, label: v.label, detail: `${bytes(v.used)} used` });
  }
  return list;
}

function renderPlaces(active) {
  const el = root.querySelector("#st-places");
  el.innerHTML =
    places()
      .map((p) => `<button class="place ${active === p.path ? "on" : ""}" data-scan="${esc(p.path)}"><b>${esc(p.label)}</b><span>${esc(p.detail)}</span></button>`)
      .join("") +
    `<form class="path-input" id="st-custom"><input placeholder="Another folder, for example /var" aria-label="Folder to scan" value="${esc(
      active && !places().some((p) => p.path === active) ? active : ""
    )}"><button class="btn">Scan</button></form>`;
  el.querySelector("#st-custom").onsubmit = (e) => {
    e.preventDefault();
    const v = e.target.querySelector("input").value.trim();
    if (v) startScan(v.replace(/^~/, store.home));
  };
}

async function startScan(path) {
  try {
    await call("scan_start", { path });
    current = null;
    prefs.set("scan.last", path);
    renderPlaces(path);
    pollScan();
  } catch (e) {
    toast(e.message, "bad");
  }
}

function pollScan() {
  clearTimeout(scanTimer);
  call("scan_status")
    .then((s) => {
      lastStatus = s;
      renderScan(s);
      if (s.running) scanTimer = setTimeout(pollScan, 350);
      else if (s.done) {
        recordBreakdown(s);
        if (!current || !current.startsWith(s.root)) current = pendingPath && pendingPath.startsWith(s.root) ? pendingPath : s.root;
        pendingPath = null;
        loadResults();
      }
    })
    .catch((e) => toast(e.message, "bad"));
}

function renderScan(s) {
  const el = root.querySelector("#st-scan");
  if (s.running) {
    el.innerHTML = `<div class="panel scan-progress"><span class="spinner"></span><div class="sp-text"><b>Measuring ${esc(tildify(s.root))}…</b> <span class="num">${plural(s.files, "file")}, ${bytes(
      s.bytes
    )} so far</span><div class="sp-path">${esc(((p) => (p.length > 110 ? "…" + p.slice(-110) : p))(tildify(s.current)))}</div></div><button class="btn" id="st-stop">Stop</button></div>`;
    el.querySelector("#st-stop").onclick = () => call("scan_cancel");
    root.querySelector("#st-results").innerHTML = "";
  } else if (!s.done) {
    el.innerHTML = s.root
      ? `<div class="panel empty"><h3>The scan was stopped</h3><p>Pick a place above to measure it again.</p></div>`
      : `<div class="panel empty"><h3>Find out what takes up space</h3><p>Pick a place above. Clearsight measures every folder and shows the biggest first.</p></div>`;
  } else {
    el.innerHTML = "";
  }
}

async function loadResults() {
  const res = root.querySelector("#st-results");
  const s = lastStatus;
  const tabs = `<div class="row-gap mb" style="justify-content:space-between"><div class="seg" id="st-sub-tabs"><button data-sub="folders">Folders</button><button data-sub="big">Largest files</button><button data-sub="rebuild">Rebuildable folders</button></div><span class="muted" style="font-size:12.5px">${plural(
    s.files,
    "file"
  )} measured in ${s.seconds.toFixed(1)} s${s.errors ? `, ${plural(s.errors, "folder")} could not be read` : ""}.${s.decrypted?.length ? " Your encrypted home folder is shown decrypted." : ""}</span><button class="btn small" id="st-rescan">${icons.refresh}Scan again</button></div>`;
  let body = "";
  try {
    if (sub === "folders") body = await foldersHtml();
    else if (sub === "big") body = await bigHtml();
    else body = await rebuildHtml();
  } catch (e) {
    body = `<div class="panel empty"><h3>${esc(e.message)}</h3></div>`;
  }
  res.innerHTML = tabs + body;
  res.querySelectorAll("#st-sub-tabs button").forEach((b) => {
    b.classList.toggle("on", b.dataset.sub === sub);
    b.onclick = () => {
      sub = b.dataset.sub;
      loadResults();
    };
  });
  res.querySelector("#st-rescan").onclick = () => {
    pendingPath = current;
    startScan(s.root);
  };
}

async function foldersHtml() {
  const l = await call("scan_list", { path: current });
  const rootPath = l.root;
  const rel = current === rootPath ? [] : current.slice(rootPath.length).split("/").filter(Boolean);
  const crumbs = [`<button data-cd="${esc(rootPath)}">${esc(tildify(rootPath) || "/")}</button>`];
  let acc = rootPath;
  for (const part of rel) {
    acc = acc === "/" ? "/" + part : acc + "/" + part;
    crumbs.push(`<span class="sep">/</span><button data-cd="${esc(acc)}">${esc(part)}</button>`);
  }
  const max = Math.max(1, ...l.entries.map((e) => e.size));
  const rows = l.entries
    .map((e) => {
      const ex = e.is_other ? "Files under 1 MB, grouped together" : explainPath(e.path, e.name);
      const cls = e.is_dir ? "folder dir" : "folder";
      const ico = e.is_dir ? `<span class="f-ico">${icons.folder}</span>` : `<span class="f-ico file">${e.is_other ? icons.files : icons.file}</span>`;
      const actions = e.is_other
        ? ""
        : `<button class="mini-btn" data-open="${esc(e.path)}" data-reveal="${e.is_dir ? "" : "1"}" title="Show in file manager">${icons.open}</button><button class="mini-btn del" data-del="${esc(
            e.path
          )}" data-size="${e.size}" title="Delete">${icons.trash}</button>`;
      return `<div class="${cls}" ${e.is_dir ? `data-cd="${esc(e.path)}"` : ""} tabindex="0">${ico}<div class="f-name"><div>${esc(e.name)}</div>${
        ex ? `<div class="explain">${esc(ex)}</div>` : e.is_dir ? `<div class="explain">${plural(e.files, "file")}</div>` : `<div class="explain">${esc(dateTime(e.mtime))}</div>`
      }</div>${bar([{ v: (e.size / max) * 100, c: e.is_dir ? "var(--disk)" : "var(--faint)" }])}<span class="f-size">${bytes(e.size)}</span><span class="f-actions">${actions}</span></div>`;
    })
    .join("");
  return `<div class="panel flush"><div style="padding:14px 18px 10px"><div class="crumbs">${crumbs.join("")}</div><div class="muted" style="font-size:13px">${bytes(l.size)} in ${plural(
    l.files,
    "file"
  )}. Click a folder to look inside.</div></div><div class="folders">${rows || `<div class="empty"><h3>This folder is empty</h3></div>`}</div></div>`;
}

async function bigHtml() {
  const files = await call("scan_big_files");
  if (!files.length) return `<div class="panel empty"><h3>No files over 100 MB here</h3><p>Large files are usually videos, disk images, game data or archives.</p></div>`;
  const max = files[0].size;
  return `<div class="panel flush"><div class="folders">${files
    .map((f) => {
      const name = f.path.split("/").pop();
      const dir = tildify(f.path.slice(0, f.path.length - name.length - 1));
      return `<div class="folder" tabindex="0"><span class="f-ico file">${icons.file}</span><div class="f-name"><div>${esc(name)}</div><div class="explain">${esc(dir)}, changed ${esc(
        dateTime(f.mtime)
      )}</div></div>${bar([{ v: (f.size / max) * 100, c: "var(--disk)" }])}<span class="f-size">${bytes(f.size)}</span><span class="f-actions"><button class="mini-btn" data-open="${esc(
        f.path
      )}" data-reveal="1" title="Show in file manager">${icons.open}</button><button class="mini-btn del" data-del="${esc(f.path)}" data-size="${f.size}" title="Delete">${icons.trash}</button></span></div>`;
    })
    .join("")}</div></div>`;
}

async function rebuildHtml() {
  const list = await call("scan_rebuildable");
  if (!list.length)
    return `<div class="panel empty"><h3>Nothing to rebuild here</h3><p>This lists folders that tools can recreate on their own, such as node_modules, Rust target folders and Python virtual environments.</p></div>`;
  const total = list.reduce((a, r) => a + r.size, 0);
  const max = list[0].size;
  return `<div class="panel flush"><div style="padding:14px 18px" class="row-gap"><div style="flex:1"><b>${bytes(total)} in ${plural(list.length, "folder")}</b><div class="muted" style="font-size:13px">Your projects stay intact. The tool that made each folder recreates it the next time you build or install.</div></div></div><div class="folders">${list
    .map((r) => {
      const name = r.path.split("/").slice(-2).join("/");
      return `<div class="folder" tabindex="0"><span class="f-ico">${icons.folder}</span><div class="f-name"><div title="${esc(r.path)}">${esc(name)}</div><div class="explain">${esc(r.kind)}, in ${esc(
        tildify(r.path.split("/").slice(0, -2).join("/"))
      )}</div></div>${bar([{ v: (r.size / max) * 100, c: "var(--disk)" }])}<span class="f-size">${bytes(r.size)}</span><span class="f-actions"><button class="mini-btn" data-open="${esc(
        r.path
      )}" title="Show in file manager">${icons.open}</button><button class="mini-btn del" data-del="${esc(r.path)}" data-size="${r.size}" title="Delete">${icons.trash}</button></span></div>`;
    })
    .join("")}</div></div>`;
}

async function deletePath(path, size) {
  const name = path.split("/").pop();
  const homeVol = (store.storage?.volumes || []).find((v) => v.role === "home");
  const inHome = store.home && path.startsWith(store.home + "/");
  const choice = await dialog({
    title: `Delete “${name}”?`,
    body: `<p>This frees <b>${bytes(size)}</b>.</p><p style="font-size:13px">${esc(tildify(path))}</p>${
      inHome || homeVol ? `<p style="font-size:13px">Moving to the Trash keeps the files, so no space is freed until you empty the Trash.</p>` : ""
    }`,
    buttons: [
      { label: "Cancel", value: null },
      { label: "Move to Trash", value: "trash" },
      { label: "Delete permanently", value: "delete", cls: "danger solid" },
    ],
  });
  if (!choice) return;
  try {
    const r = await call("delete_paths", { paths: [path], permanent: choice === "delete" });
    if (r.errors.length) toast(r.errors[0], "bad");
    if (r.deleted.length) toast(choice === "delete" ? `Deleted “${name}”. ${bytes(size)} freed.` : `“${name}” is in the Trash.`);
    bus.emit("refresh-storage");
    loadResults();
  } catch (e) {
    toast(e.message, "bad");
  }
}

function setTab(t) {
  tab = t;
  root.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
  root.querySelector("#st-drives").style.display = t === "drives" ? "" : "none";
  root.querySelector("#st-explore").style.display = t === "explore" ? "" : "none";
  if (t === "explore") {
    renderPlaces(lastStatus?.root);
    if (!lastStatus) {
      call("scan_status").then((s) => {
        lastStatus = s;
        renderPlaces(s.root);
        if (s.running || s.done) pollScan();
        else renderScan(s);
      });
    }
  }
}

export default {
  mount(el) {
    root = el;
    root.innerHTML = `<div class="page-head"><div class="titles"><h1>Storage</h1><p id="st-sub">Your drives and what is on them.</p></div><div class="tools"><button class="btn" id="st-refresh">${icons.refresh}Refresh</button></div></div>
      <div class="tabs"><button data-tab="drives" class="on">Drives</button><button data-tab="explore">What uses space</button></div>
      <div id="st-drives"></div>
      <div id="st-explore" style="display:none"><div class="places mb" id="st-places"></div><div id="st-scan"></div><div id="st-results"></div></div>`;
    root.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
    root.querySelector("#st-refresh").onclick = () => bus.emit("refresh-storage");
    bus.on("storage", () => renderDrives());
    root.addEventListener("click", async (e) => {
      const t = e.target;
      const open = t.closest("[data-open]");
      if (open) {
        e.stopPropagation();
        call("open_path", { path: open.dataset.open, reveal: !!open.dataset.reveal }).catch((err) => toast(err.message, "bad"));
        return;
      }
      const del = t.closest("[data-del]");
      if (del) {
        e.stopPropagation();
        deletePath(del.dataset.del, Number(del.dataset.size));
        return;
      }
      const ex = t.closest("[data-explore]");
      if (ex) {
        setTab("explore");
        if (lastStatus?.done && lastStatus.root === ex.dataset.explore) return;
        startScan(ex.dataset.explore);
        return;
      }
      const sc = t.closest("[data-scan]");
      if (sc) {
        startScan(sc.dataset.scan);
        return;
      }
      const cd = t.closest("[data-cd]");
      if (cd) {
        current = cd.dataset.cd;
        loadResults();
        return;
      }
      const rs = t.closest("[data-reserve]");
      if (rs) {
        const ok = await confirmAction(
          "Lower the reserved space to 1%?",
          "This runs “tune2fs -m 1” on the drive. Your files are not touched and the change takes effect immediately. 1% stays reserved so the system can still recover when the drive is full.",
          "Lower to 1%",
          { admin: true }
        );
        if (!ok) return;
        try {
          await call("reduce_reserved", { device: rs.dataset.reserve });
          toast("Done. The reserved space now counts as free space.");
          bus.emit("refresh-storage");
        } catch (err) {
          toast(err.message, "bad");
        }
      }
    });
    root.addEventListener("keydown", (e) => {
      const row = e.target.closest(".folder[data-cd]");
      if (row && e.key === "Enter") {
        current = row.dataset.cd;
        loadResults();
      }
      if (e.key === "Backspace" && tab === "explore" && current && lastStatus && current !== lastStatus.root && e.target.tagName !== "INPUT") {
        current = current.split("/").slice(0, -1).join("/") || "/";
        loadResults();
      }
    });
    renderDrives();
  },

  show(opts = {}) {
    if (opts.tab) setTab(opts.tab);
    else setTab(tab);
    if (opts.path) {
      if (lastStatus?.done && opts.path.startsWith(lastStatus.root)) {
        current = opts.path;
        loadResults();
      } else startScan(opts.path);
    }
  },
};
