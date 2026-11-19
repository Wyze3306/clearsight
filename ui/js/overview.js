import { esc, bytes, rate, pct, duration, bar, levelColor, sparkline, store, go, appIcon, bus } from "./core.js";
import { groupApps, mainVolume } from "./model.js";

let root;

function insights(s) {
  const out = [];
  const m = s.memory;
  const vols = (store.storage?.volumes || []).filter((v) => ["system", "home", "data"].includes(v.role));
  const seen = new Set();
  for (const v of vols) {
    const key = v.backed_by || v.mount;
    if (seen.has(key)) continue;
    seen.add(key);
    const ratio = v.avail / v.size;
    const shared = vols.some((o) => o.backed_by === v.mount);
    const name = shared ? "Your system drive (which also holds your home folder)" : v.label === "System" ? "Your system drive" : `“${v.label}”`;
    if (v.size > 2 * 1024 ** 3 && (ratio < 0.05 || v.avail < 5 * 1024 ** 3)) {
      out.push({
        level: "bad",
        phrase: "your drive is almost full",
        title: `${name} is almost full`,
        text: `Only ${bytes(v.avail)} left of ${bytes(v.size)}. Apps can fail to save files or update when a drive is full.`,
        actions: [
          { label: "Clean up", page: "cleanup", primary: true },
          { label: "See what uses space", page: "storage", opts: { tab: "explore", path: v.role === "home" || shared ? store.home : v.mount } },
        ],
      });
    } else if (v.size > 2 * 1024 ** 3 && (ratio < 0.12 || v.avail < 15 * 1024 ** 3)) {
      out.push({
        level: "warn",
        phrase: "your drive is getting full",
        title: `${name} is getting full`,
        text: `${bytes(v.avail)} left of ${bytes(v.size)}.`,
        actions: [{ label: "Clean up", page: "cleanup", primary: true }],
      });
    }
    if (v.can_reduce_reserved) {
      out.push({
        level: "info",
        title: `${bytes(v.reserved)} of “${v.label}” is held in reserve`,
        text: `The ext4 file system keeps 5% aside for emergencies. Lowering it to 1% would give you about ${bytes(v.reserved - v.size * 0.01)} back.`,
        actions: [{ label: "Review", page: "storage", opts: { tab: "drives" } }],
      });
    }
  }

  const groups = groupApps(s.processes);
  const byMem = [...groups].sort((a, b) => b.mem + b.swap - (a.mem + a.swap));
  const swapRatio = m.swap_used / m.total;
  const memRatio = m.used / m.total;
  if (memRatio > 0.9 || swapRatio > 0.5) {
    const top = byMem[0];
    out.push({
      level: "bad",
      phrase: "memory is running short",
      title: "Your computer is short on memory",
      text: `${m.swap_used > 512 * 1024 ** 2 ? `Linux moved ${bytes(m.swap_used)} of app data to swap, which slows things down. ` : ""}${
        top ? `${top.name} uses the most: ${bytes(top.mem + top.swap)}.` : ""
      }`,
      actions: [{ label: "Free memory", page: "memory", primary: true }],
    });
  } else if (memRatio > 0.8 || swapRatio > 0.2) {
    out.push({
      level: "warn",
      phrase: "memory is getting tight",
      title: "Memory is getting tight",
      text: `${bytes(m.available)} is still available.`,
      actions: [{ label: "See memory", page: "memory" }],
    });
  }

  const recent = store.history.cpu.slice(-4);
  const avg = recent.reduce((a, b) => a + b, 0) / Math.max(1, recent.length);
  const byCpu = [...groups].sort((a, b) => b.cpu - a.cpu);
  if (avg > 85 && recent.length >= 3) {
    out.push({
      level: "warn",
      phrase: "the processor is very busy",
      title: "Your processor is very busy",
      text: byCpu[0] ? `${byCpu[0].name} is using ${pct(byCpu[0].cpu)} of it.` : "",
      actions: [{ label: "See apps", page: "processes", opts: { sort: "cpu" }, primary: true }],
    });
  } else if (byCpu[0] && byCpu[0].cpu > 40 && recent.length >= 3) {
    out.push({
      level: "info",
      title: `${byCpu[0].name} is using ${pct(byCpu[0].cpu)} of your processor`,
      text: "That is a lot for a single app. If you are not using it right now, you can pause or end it.",
      actions: [{ label: "Show it", page: "processes", opts: { select: byCpu[0].key } }],
    });
  }
  if (s.cpu_temp && s.cpu_temp > 88) {
    out.push({
      level: "warn",
      phrase: "the processor is running hot",
      title: `Your processor is hot (${Math.round(s.cpu_temp)} °C)`,
      text: "Check that the vents are not blocked and see which apps keep it busy.",
      actions: [{ label: "See apps", page: "processes", opts: { sort: "cpu" } }],
    });
  }
  const paused = groups.filter((g) => g.paused);
  if (paused.length) {
    out.push({
      level: "info",
      title: `${paused.length === 1 ? paused[0].name + " is" : paused.length + " apps are"} paused`,
      text: "Paused apps keep their memory but use no processor time.",
      actions: [{ label: "Show", page: "processes", opts: { select: paused[0].key } }],
    });
  }
  return out;
}

function verdict(list) {
  const phrases = list.filter((i) => i.phrase).map((i) => i.phrase);
  if (!phrases.length) return "Everything is running smoothly.";
  const text = phrases.length === 1 ? phrases[0] : phrases.slice(0, -1).join(", ") + " and " + phrases.at(-1);
  return text[0].toUpperCase() + text.slice(1) + ".";
}

function topList(groups, metric, fmt, color) {
  const top = [...groups].sort((a, b) => metric(b) - metric(a)).slice(0, 6);
  const max = Math.max(...top.map(metric), 1e-9);
  return `<div class="list">${top
    .map(
      (g) => `<div class="list-row" data-key="${esc(g.key)}" style="cursor:pointer;grid-template-columns:22px minmax(0,1fr) auto">${appIcon(g.info, g.name)}<div style="min-width:0"><div class="nm">${esc(g.name)}${
        g.procs.length > 1 ? ` <span class="meta">${g.procs.length} processes</span>` : ""
      }</div>${bar([{ v: (metric(g) / max) * 100, c: color }])}</div><span class="val num">${fmt(g)}</span></div>`
    )
    .join("")}</div>`;
}

export default {
  mount(el) {
    root = el;
    root.innerHTML = `<div class="page-head"><div class="titles"><h1 class="verdict" id="ov-verdict">Looking at your computer…</h1><p class="verdict-sub" id="ov-sub"></p></div></div>
      <div class="insights" id="ov-insights"></div>
      <div class="grid cols-3">
        <div class="panel tile" data-go="processes"><div class="tile-top"><span class="tile-name">Processor</span><span class="tile-value num" id="ov-cpu"></span></div><canvas id="ov-cpu-chart"></canvas><div class="tile-detail" id="ov-cpu-detail"></div></div>
        <div class="panel tile" data-go="memory"><div class="tile-top"><span class="tile-name">Memory</span><span class="tile-value num" id="ov-mem"></span></div><canvas id="ov-mem-chart"></canvas><div class="tile-detail" id="ov-mem-detail"></div></div>
        <div class="panel tile" data-go="storage"><div class="tile-top"><span class="tile-name">Main drive</span><span class="tile-value num" id="ov-disk"></span></div><div id="ov-disk-bar" style="margin:22px 0 20px"></div><div class="tile-detail" id="ov-disk-detail"></div></div>
      </div>
      <div class="grid cols-2 mt">
        <div class="panel"><div class="panel-head"><h2>Using the most processor</h2><button class="btn small" data-go="processes" data-sort="cpu">All apps</button></div><div id="ov-top-cpu"></div></div>
        <div class="panel"><div class="panel-head"><h2>Using the most memory</h2><button class="btn small" data-go="processes" data-sort="mem">All apps</button></div><div id="ov-top-mem"></div></div>
      </div>
      <div class="grid cols-3 mt">
        <div class="panel"><h2>Network</h2><p class="hint">All connections combined</p><canvas class="chart" id="ov-net" style="height:70px"></canvas><dl class="kv mt" id="ov-net-kv"></dl></div>
        <div class="panel"><h2>Disk activity</h2><p class="hint">Reading and writing on your drives</p><canvas class="chart" id="ov-io" style="height:70px"></canvas><dl class="kv mt" id="ov-io-kv"></dl></div>
        <div class="panel"><h2>This computer</h2><p class="hint" id="ov-host"></p><dl class="kv" id="ov-sys"></dl></div>
      </div>`;
    root.querySelectorAll("[data-go]").forEach((el) => {
      el.onclick = (e) => {
        e.stopPropagation();
        go(el.dataset.go, el.dataset.sort ? { sort: el.dataset.sort } : undefined);
      };
    });
    root.addEventListener("click", (e) => {
      const row = e.target.closest(".list-row[data-key]");
      if (row) go("processes", { select: row.dataset.key });
      const btn = e.target.closest("[data-action]");
      if (btn) {
        const a = JSON.parse(btn.dataset.action);
        go(a.page, a.opts);
      }
    });
    bus.on("storage", () => store.snap && this.update(store.snap));
  },

  update(s) {
    const list = insights(s);
    root.querySelector("#ov-verdict").textContent = verdict(list);
    root.querySelector("#ov-sub").textContent = `${s.hostname} running ${s.distro}, on for ${duration(s.uptime)}.`;
    const ins = root.querySelector("#ov-insights");
    const html = list.length
      ? list
          .map(
            (i) => `<div class="insight ${i.level}"><span class="stripe"></span><div><strong>${esc(i.title)}</strong>${i.text ? `<p>${esc(i.text)}</p>` : ""}</div><div class="actions">${(
              i.actions || []
            )
              .map((a) => `<button class="btn small ${a.primary ? "primary" : ""}" data-action='${esc(JSON.stringify({ page: a.page, opts: a.opts }))}'>${esc(a.label)}</button>`)
              .join("")}</div></div>`
          )
          .join("")
      : `<div class="insight good"><span class="stripe"></span><div><strong>No problems found</strong><p>Processor, memory and storage all have room to spare.</p></div><div></div></div>`;
    if (ins.dataset.html !== html) {
      ins.innerHTML = html;
      ins.dataset.html = html;
    }

    const m = s.memory;
    root.querySelector("#ov-cpu").textContent = pct(s.cpu_total);
    root.querySelector("#ov-cpu-detail").textContent = `${s.cpu_model.replace(/\(R\)|\(TM\)|CPU|Processor/g, "").replace(/\s+/g, " ").trim()}${
      s.cpu_temp ? `, ${Math.round(s.cpu_temp)} °C` : ""
    }`;
    sparkline(root.querySelector("#ov-cpu-chart"), store.history.cpu, { max: 100, color: "--cpu" });
    root.querySelector("#ov-mem").textContent = `${bytes(m.used)}`;
    root.querySelector("#ov-mem-detail").textContent = `of ${bytes(m.total)} in use. ${bytes(m.available)} available${
      m.swap_used > 64 * 1024 ** 2 ? `, plus ${bytes(m.swap_used)} in swap` : ""
    }.`;
    sparkline(root.querySelector("#ov-mem-chart"), store.history.mem, { max: 100, color: "--mem" });

    const vol = mainVolume();
    if (vol) {
      const ratio = vol.used / vol.size;
      root.querySelector("#ov-disk").textContent = `${bytes(vol.avail)} free`;
      root.querySelector("#ov-disk-bar").innerHTML = bar([{ v: ratio * 100, c: levelColor(ratio) || "var(--disk)" }], "thick");
      root.querySelector("#ov-disk-detail").textContent = `${bytes(vol.used)} used of ${bytes(vol.size)} on ${vol.label.toLowerCase()}.`;
    }

    const groups = groupApps(s.processes);
    root.querySelector("#ov-top-cpu").innerHTML = topList(groups, (g) => g.cpu, (g) => pct(g.cpu, 1), "var(--cpu)");
    root.querySelector("#ov-top-mem").innerHTML = topList(groups, (g) => g.mem, (g) => bytes(g.mem), "var(--mem)");

    sparkline(root.querySelector("#ov-net"), [store.history.rx, store.history.tx], { color: ["--net", "--faint"], fill: false });
    root.querySelector("#ov-net-kv").innerHTML = `<dt><span style="color:var(--net)">●</span> Downloading</dt><dd>${rate(s.net_rx_rate)}</dd><dt><span style="color:var(--faint)">●</span> Uploading</dt><dd>${rate(s.net_tx_rate)}</dd>`;
    const dr = s.disks.reduce((a, d) => a + d.read_rate, 0);
    const dw = s.disks.reduce((a, d) => a + d.write_rate, 0);
    sparkline(root.querySelector("#ov-io"), [store.history.dr, store.history.dw], { color: ["--disk", "--faint"], fill: false });
    root.querySelector("#ov-io-kv").innerHTML = `<dt><span style="color:var(--disk)">●</span> Reading</dt><dd>${rate(dr)}</dd><dt><span style="color:var(--faint)">●</span> Writing</dt><dd>${rate(dw)}</dd>`;
    root.querySelector("#ov-host").textContent = `${s.distro}, kernel ${s.kernel}`;
    root.querySelector("#ov-sys").innerHTML = `<dt>Processor cores</dt><dd>${s.cpu_cores.length}</dd><dt>Average speed</dt><dd>${(s.cpu_freq_mhz / 1000).toFixed(2)} GHz</dd><dt>Load (1 / 5 / 15 min)</dt><dd>${s.load
      .map((l) => l.toFixed(1))
      .join(" / ")}</dd><dt>Running processes</dt><dd>${s.processes.length}</dd><dt>Installed memory</dt><dd>${bytes(m.total)}</dd>`;
  },
};
