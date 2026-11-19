import { store, call } from "./core.js";

const pending = new Set();

export function ensureAppInfo(keys) {
  const missing = keys.filter((k) => !(k in store.apps) && !pending.has(k));
  if (!missing.length) return Promise.resolve(false);
  missing.forEach((k) => pending.add(k));
  return call("app_info", { keys: missing })
    .then((res) => {
      Object.assign(store.apps, res);
      return true;
    })
    .catch(() => false)
    .finally(() => missing.forEach((k) => pending.delete(k)));
}

export function displayName(key) {
  return store.apps[key]?.name || key;
}

const HELPERS = new Set(["WebKitWebProcess", "WebKitNetworkProcess", "WebKitGPUProcess", "WebKitWebDriver", "crashpad_handler", "chrome_crashpad_handler", "zypak-helper", "zypak-sandbox"]);

function owningApp(p, byPid) {
  let cur = p;
  for (let i = 0; i < 8 && cur && HELPERS.has(cur.app); i++) cur = byPid.get(cur.ppid);
  return cur && !HELPERS.has(cur.app) && cur.pid > 1 ? cur.app : p.app;
}

export function groupApps(procs, { mineOnly = false } = {}) {
  const map = new Map();
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  for (const p of procs) {
    if (HELPERS.has(p.app)) p.app = owningApp(p, byPid);
    if (mineOnly && !p.own) continue;
    let g = map.get(p.app);
    if (!g) {
      g = { key: p.app, procs: [], cpu: 0, mem: 0, swap: 0, read: 0, write: 0, threads: 0, users: new Set(), stopped: 0, own: true, started: Infinity };
      map.set(p.app, g);
    }
    g.procs.push(p);
    g.cpu += p.cpu;
    g.mem += p.mem;
    g.swap += p.swap;
    g.read += p.read_rate;
    g.write += p.write_rate;
    g.threads += p.threads;
    g.users.add(p.user);
    if (p.state === "T" || p.state === "t") g.stopped++;
    if (!p.own) g.own = false;
    if (p.started < g.started) g.started = p.started;
  }
  const groups = [...map.values()];
  const names = new Map();
  for (const g of groups) {
    g.name = displayName(g.key);
    g.info = store.apps[g.key];
    names.set(g.name, (names.get(g.name) || 0) + 1);
  }
  for (const g of groups) {
    if (names.get(g.name) > 1 && g.name !== g.key) g.name = `${g.name} (${g.key})`;
    g.paused = g.stopped > 0 && g.stopped === g.procs.length;
    g.procs.sort((a, b) => b.cpu - a.cpu || b.mem - a.mem);
  }
  return groups;
}

export function memoryParts(m) {
  const appsMem = Math.max(0, m.used - m.shared);
  return {
    apps: appsMem,
    shared: m.shared,
    cache: Math.max(0, m.available - m.free),
    free: m.free,
  };
}

export function mainVolume() {
  const vols = store.storage?.volumes || [];
  const home = vols.find((v) => v.role === "home");
  const sys = vols.find((v) => v.role === "system");
  if (home && sys && home.backed_by === sys.mount) return { ...sys, label: "System and home folder" };
  return home || sys || vols[0];
}
