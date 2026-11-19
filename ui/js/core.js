const tauri = window.__TAURI__;

export function call(cmd, args = {}) {
  if (!tauri) return Promise.reject(new Error("Clearsight must run inside its desktop window."));
  return tauri.core.invoke(cmd, args).catch((e) => {
    throw new Error(typeof e === "string" ? e : e?.message || String(e));
  });
}

export function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function bytes(n, digits) {
  if (n == null || isNaN(n)) return "–";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  let v = Math.abs(n);
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const d = digits ?? (i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : i >= 3 ? 2 : 1);
  return `${v.toFixed(d)} ${units[i]}`;
}

export function rate(n) {
  if (!n) return "0 B/s";
  return `${bytes(n)}/s`;
}

export function pct(v, d = 0) {
  if (v == null || isNaN(v)) return "–";
  if (v > 0 && v < 0.1 && d === 1) return "<0.1%";
  return `${v.toFixed(d)}%`;
}

export function plural(n, one, many) {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many || one + "s"}`;
}

export function duration(secs) {
  secs = Math.max(0, Math.floor(secs));
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min`;
  return `${secs} s`;
}

export function ago(unixSecs) {
  const s = Date.now() / 1000 - unixSecs;
  if (s < 60) return "just now";
  return `${duration(s)} ago`;
}

export function dateTime(unixSecs) {
  return new Date(unixSecs * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export const icons = {
  chevron: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6-1.4-1.4L12.2 12 7.6 7.4z"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V8h4.5z"/></svg>',
  files: '<svg viewBox="0 0 24 24"><path d="M4 6h2v14h12v2H6a2 2 0 0 1-2-2zm4-4h8l4 4v10a2 2 0 0 1-2 2h-10a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/></svg>',
  open: '<svg viewBox="0 0 24 24"><path d="M14 3h7v7h-2V6.4l-9.3 9.3-1.4-1.4L17.6 5H14zM5 5h6v2H5v12h12v-6h2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" class="lock"><path d="M7 10V8a5 5 0 0 1 10 0v2h1a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V11a1 1 0 0 1 1-1zm2 0h6V8a3 3 0 0 0-6 0z"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5z"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6.4 5L12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4z"/></svg>',
  search: '<svg viewBox="0 0 24 24"><path d="M10 3a7 7 0 0 1 5.6 11.2l5.1 5.1-1.4 1.4-5.1-5.1A7 7 0 1 1 10 3zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10z"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M11 4h2v12l4.5-4.5 1.4 1.4L12 19.8l-6.9-6.9 1.4-1.4L11 16z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M12 4a8 8 0 0 1 7.7 5.9H17.6A6 6 0 1 0 18 14h2.1A8 8 0 1 1 12 4zm5 1h4v4z"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><path d="M12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10zM11 1h2v3h-2zm0 19h2v3h-2zM1 11h3v2H1zm19 0h3v2h-3zM4.2 2.8l2.1 2.1-1.4 1.4-2.1-2.1zm14.9 14.9l2.1 2.1-1.4 1.4-2.1-2.1zM2.8 19.8l2.1-2.1 1.4 1.4-2.1 2.1zM17.7 4.9l2.1-2.1 1.4 1.4-2.1 2.1z"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z"/></svg>',
};

export function h(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function toast(message, kind = "") {
  const el = h(`<div class="toast ${kind}">${esc(message)}</div>`);
  document.getElementById("toasts").appendChild(el);
  setTimeout(() => el.remove(), kind === "bad" ? 7000 : 4200);
}

export function dialog({ title, body = "", list = [], buttons }) {
  const d = document.getElementById("dialog");
  return new Promise((resolve) => {
    d.innerHTML = `<h2>${esc(title)}</h2>${body}${
      list.length ? `<div class="d-list">${list.map((l) => `<div>${esc(l)}</div>`).join("")}</div>` : ""
    }<div class="d-buttons"></div>`;
    const row = d.querySelector(".d-buttons");
    buttons.forEach((b) => {
      const btn = h(`<button class="btn ${b.cls || ""}">${b.icon || ""}${esc(b.label)}</button>`);
      btn.onclick = () => {
        d.close();
        resolve(b.value);
      };
      row.appendChild(btn);
    });
    d.onclose = () => resolve(d.returnValue === "" ? null : undefined);
    d.oncancel = () => resolve(null);
    d.showModal();
    const primary = row.querySelector(".primary, .solid");
    (primary || row.lastElementChild)?.focus();
  });
}

export function confirmAction(title, body, label, { danger = false, admin = false, list = [] } = {}) {
  return dialog({
    title,
    body: `<p>${body}</p>`,
    list,
    buttons: [
      { label: "Cancel", value: false },
      { label, value: true, cls: danger ? "danger solid" : "primary", icon: admin ? icons.lock : "" },
    ],
  });
}

const palette = ["#4f7cff", "#9b5cf0", "#e0613f", "#1f9d8b", "#d6a400", "#d94a8c", "#3a9e4f", "#6b6fd6", "#c2662d", "#2b8fc9"];

export function letterIcon(name, cls = "app-icon") {
  const n = (name || "?").replace(/[^A-Za-z0-9]/g, "") || "?";
  let hash = 0;
  for (const c of n) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return `<span class="${cls} letter" style="background:${palette[hash % palette.length]}">${esc(n[0].toUpperCase())}</span>`;
}

export function appIcon(info, name) {
  if (info?.icon) return `<img class="app-icon" src="${info.icon}" alt="">`;
  return letterIcon(name);
}

export function bar(parts, cls = "") {
  return `<div class="bar ${cls}">${parts
    .filter((p) => p.v > 0)
    .map((p) => `<i style="width:${Math.min(100, p.v).toFixed(2)}%;background:${p.c}"${p.t ? ` title="${esc(p.t)}"` : ""}></i>`)
    .join("")}</div>`;
}

export function levelColor(ratio) {
  if (ratio >= 0.92) return "var(--bad)";
  if (ratio >= 0.8) return "var(--warn)";
  return null;
}

export function sparkline(canvas, series, { max, color, fill = true, min = 0 } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const hgt = canvas.clientHeight;
  if (!w || !hgt) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
  const css = getComputedStyle(document.documentElement);
  const resolve = (c) => (c.startsWith("--") ? css.getPropertyValue(c).trim() : c);
  const colors = (Array.isArray(color) ? color : [color]).map(resolve);
  const col = colors[0];
  const lineCol = css.getPropertyValue("--line").trim();
  ctx.strokeStyle = lineCol;
  ctx.lineWidth = 1;
  for (const f of [0.5]) {
    ctx.beginPath();
    ctx.moveTo(0, Math.round(hgt * f) + 0.5);
    ctx.lineTo(w, Math.round(hgt * f) + 0.5);
    ctx.stroke();
  }
  const lists = Array.isArray(series[0]) ? series : [series];
  const top = max ?? Math.max(1, ...lists.flat());
  const N = 60;
  lists.forEach((list, li) => {
    if (!list.length) return;
    const c = colors[li] || col;
    const step = w / (N - 1);
    const off = (N - list.length) * step;
    ctx.beginPath();
    list.forEach((v, i) => {
      const x = off + i * step;
      const y = hgt - ((Math.max(min, v) - min) / (top - min)) * (hgt - 3) - 1.5;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = c;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = "round";
    ctx.stroke();
    if (fill && li === 0) {
      ctx.lineTo(w, hgt);
      ctx.lineTo(off, hgt);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, 0, 0, hgt);
      g.addColorStop(0, c + "55");
      g.addColorStop(1, c + "05");
      ctx.fillStyle = g;
      ctx.fill();
    }
  });
}

export const bus = {
  handlers: {},
  on(evt, fn) {
    (this.handlers[evt] ||= []).push(fn);
  },
  emit(evt, data) {
    (this.handlers[evt] || []).forEach((fn) => fn(data));
  },
};

export const store = {
  snap: null,
  history: { cpu: [], mem: [], swap: [], rx: [], tx: [], dr: [], dw: [] },
  apps: {},
  storage: null,
  home: "",
};

export function pushHistory(key, v) {
  const arr = store.history[key];
  arr.push(v);
  if (arr.length > 60) arr.shift();
}

export const prefs = {
  get(k, d) {
    try {
      const v = localStorage.getItem("clearsight." + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem("clearsight." + k, JSON.stringify(v));
    } catch {}
  },
};

export function tildify(p) {
  if (store.home && p.startsWith(store.home)) return "~" + p.slice(store.home.length);
  return p;
}

export function go(page, opts) {
  bus.emit("navigate", { page, opts });
}
