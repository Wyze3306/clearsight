use crate::util::{read, uid};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[derive(Serialize, Clone)]
pub struct Proc {
    pub pid: i32,
    pub ppid: i32,
    pub name: String,
    pub cmd: String,
    pub exe: String,
    pub app: String,
    pub user: String,
    pub own: bool,
    pub state: String,
    pub cpu: f32,
    pub mem: u64,
    pub rss: u64,
    pub swap: u64,
    pub read_rate: u64,
    pub write_rate: u64,
    pub threads: u32,
    pub nice: i32,
    pub started: u64,
}

#[derive(Serialize, Clone, Default)]
pub struct Memory {
    pub total: u64,
    pub free: u64,
    pub available: u64,
    pub used: u64,
    pub cache: u64,
    pub buffers: u64,
    pub shared: u64,
    pub slab_reclaimable: u64,
    pub dirty: u64,
    pub swap_total: u64,
    pub swap_used: u64,
    pub swaps: Vec<SwapDev>,
}

#[derive(Serialize, Clone)]
pub struct SwapDev {
    pub device: String,
    pub kind: String,
    pub size: u64,
    pub used: u64,
    pub priority: i32,
    pub compressed: Option<u64>,
    pub original: Option<u64>,
}

#[derive(Serialize, Clone)]
pub struct DiskIo {
    pub name: String,
    pub read_rate: u64,
    pub write_rate: u64,
    pub busy: f32,
}

#[derive(Serialize, Clone)]
pub struct Snapshot {
    pub time: u64,
    pub cpu_total: f32,
    pub cpu_cores: Vec<f32>,
    pub cpu_model: String,
    pub cpu_freq_mhz: u32,
    pub cpu_temp: Option<f32>,
    pub load: [f32; 3],
    pub uptime: u64,
    pub memory: Memory,
    pub net_rx_rate: u64,
    pub net_tx_rate: u64,
    pub disks: Vec<DiskIo>,
    pub processes: Vec<Proc>,
    pub hostname: String,
    pub kernel: String,
    pub distro: String,
}

struct PrevProc {
    ticks: u64,
    start: u64,
    read: u64,
    write: u64,
}

pub struct Sampler {
    last: Option<Instant>,
    prev_cpu: Vec<(u64, u64)>,
    prev_procs: HashMap<i32, PrevProc>,
    prev_net: (u64, u64),
    prev_disks: HashMap<String, (u64, u64, u64)>,
    users: HashMap<u32, String>,
    clk_tck: f64,
    page: u64,
    ncpu: usize,
    boot_time: u64,
    cpu_model: String,
    my_uid: u32,
}

impl Sampler {
    pub fn new() -> Self {
        let cpuinfo = read("/proc/cpuinfo");
        let cpu_model = cpuinfo
            .lines()
            .find(|l| l.starts_with("model name"))
            .and_then(|l| l.split(':').nth(1))
            .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
            .unwrap_or_else(|| "Unknown processor".into());
        let boot_time = read("/proc/stat")
            .lines()
            .find(|l| l.starts_with("btime"))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let clk = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        let mut s = Sampler {
            last: None,
            prev_cpu: Vec::new(),
            prev_procs: HashMap::new(),
            prev_net: (0, 0),
            prev_disks: HashMap::new(),
            users: load_users(),
            clk_tck: if clk > 0 { clk as f64 } else { 100.0 },
            page: if page > 0 { page as u64 } else { 4096 },
            ncpu: 1,
            boot_time,
            cpu_model,
            my_uid: uid(),
        };
        s.ncpu = s.read_cpu().len().saturating_sub(1).max(1);
        s
    }

    fn read_cpu(&self) -> Vec<(u64, u64)> {
        read("/proc/stat")
            .lines()
            .take_while(|l| l.starts_with("cpu"))
            .map(|l| {
                let v: Vec<u64> = l.split_whitespace().skip(1).filter_map(|x| x.parse().ok()).collect();
                let idle = v.get(3).copied().unwrap_or(0) + v.get(4).copied().unwrap_or(0);
                let total: u64 = v.iter().take(8).sum();
                (total, idle)
            })
            .collect()
    }

    pub fn sample(&mut self) -> Snapshot {
        let now = Instant::now();
        let elapsed = self.last.map(|l| now.duration_since(l).as_secs_f64()).unwrap_or(0.0);
        let have_prev = elapsed > 0.05;

        let cpu = self.read_cpu();
        let usage = |cur: (u64, u64), prev: Option<&(u64, u64)>| -> f32 {
            match prev {
                Some(p) if cur.0 > p.0 => {
                    let dt = (cur.0 - p.0) as f64;
                    let di = cur.1.saturating_sub(p.1) as f64;
                    (((dt - di) / dt) * 100.0).clamp(0.0, 100.0) as f32
                }
                _ => 0.0,
            }
        };
        let cpu_total = cpu.first().map(|c| usage(*c, self.prev_cpu.first())).unwrap_or(0.0);
        let cpu_cores: Vec<f32> =
            cpu.iter().enumerate().skip(1).map(|(i, c)| usage(*c, self.prev_cpu.get(i))).collect();
        self.prev_cpu = cpu;

        let uptime_secs = read("/proc/uptime")
            .split_whitespace()
            .next()
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(0.0);

        let mut processes = Vec::with_capacity(512);
        let mut next_prev = HashMap::with_capacity(self.prev_procs.len() + 16);
        if let Ok(rd) = fs::read_dir("/proc") {
            for entry in rd.flatten() {
                let pid: i32 = match entry.file_name().to_str().and_then(|s| s.parse().ok()) {
                    Some(p) => p,
                    None => continue,
                };
                if let Some((p, prev)) = self.read_proc(pid, elapsed, have_prev) {
                    next_prev.insert(pid, prev);
                    processes.push(p);
                }
            }
        }
        self.prev_procs = next_prev;

        let (rx, tx) = read_net();
        let (net_rx_rate, net_tx_rate) = if have_prev && self.prev_net.0 > 0 {
            (
                (rx.saturating_sub(self.prev_net.0) as f64 / elapsed) as u64,
                (tx.saturating_sub(self.prev_net.1) as f64 / elapsed) as u64,
            )
        } else {
            (0, 0)
        };
        self.prev_net = (rx, tx);

        let mut disks = Vec::new();
        let mut next_disks = HashMap::new();
        for line in read("/proc/diskstats").lines() {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 14 {
                continue;
            }
            let name = f[2];
            if !is_physical_disk(name) {
                continue;
            }
            let rs: u64 = f[5].parse().unwrap_or(0);
            let ws: u64 = f[9].parse().unwrap_or(0);
            let io_ms: u64 = f[12].parse().unwrap_or(0);
            if let (true, Some(p)) = (have_prev, self.prev_disks.get(name)) {
                disks.push(DiskIo {
                    name: name.to_string(),
                    read_rate: (rs.saturating_sub(p.0) as f64 * 512.0 / elapsed) as u64,
                    write_rate: (ws.saturating_sub(p.1) as f64 * 512.0 / elapsed) as u64,
                    busy: ((io_ms.saturating_sub(p.2) as f64 / (elapsed * 1000.0)) * 100.0).min(100.0) as f32,
                });
            } else {
                disks.push(DiskIo { name: name.to_string(), read_rate: 0, write_rate: 0, busy: 0.0 });
            }
            next_disks.insert(name.to_string(), (rs, ws, io_ms));
        }
        self.prev_disks = next_disks;

        let load: Vec<f32> =
            read("/proc/loadavg").split_whitespace().take(3).filter_map(|v| v.parse().ok()).collect();
        let freqs: Vec<f64> = read("/proc/cpuinfo")
            .lines()
            .filter(|l| l.starts_with("cpu MHz"))
            .filter_map(|l| l.split(':').nth(1)?.trim().parse().ok())
            .collect();
        let cpu_freq_mhz = if freqs.is_empty() { 0 } else { (freqs.iter().sum::<f64>() / freqs.len() as f64) as u32 };

        self.last = Some(now);
        Snapshot {
            time: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
            cpu_total,
            cpu_cores,
            cpu_model: self.cpu_model.clone(),
            cpu_freq_mhz,
            cpu_temp: cpu_temp(),
            load: [load.first().copied().unwrap_or(0.0), load.get(1).copied().unwrap_or(0.0), load.get(2).copied().unwrap_or(0.0)],
            uptime: uptime_secs as u64,
            memory: read_memory(),
            net_rx_rate,
            net_tx_rate,
            disks,
            processes,
            hostname: read("/proc/sys/kernel/hostname").trim().to_string(),
            kernel: read("/proc/sys/kernel/osrelease").trim().to_string(),
            distro: distro_name(),
        }
    }

    fn read_proc(&mut self, pid: i32, elapsed: f64, have_prev: bool) -> Option<(Proc, PrevProc)> {
        let base = format!("/proc/{pid}");
        let stat = fs::read_to_string(format!("{base}/stat")).ok()?;
        let open = stat.find('(')?;
        let close = stat.rfind(')')?;
        let comm = stat[open + 1..close].to_string();
        let rest: Vec<&str> = stat[close + 2..].split_whitespace().collect();
        if rest.len() < 22 {
            return None;
        }
        let state = rest[0].to_string();
        let ppid: i32 = rest[1].parse().unwrap_or(0);
        if pid == 2 || ppid == 2 {
            return None;
        }
        let utime: u64 = rest[11].parse().unwrap_or(0);
        let stime: u64 = rest[12].parse().unwrap_or(0);
        let nice: i32 = rest[16].parse().unwrap_or(0);
        let threads: u32 = rest[17].parse().unwrap_or(1);
        let start_ticks: u64 = rest[19].parse().unwrap_or(0);
        let ticks = utime + stime;

        let status = read(format!("{base}/status"));
        let mut owner = 0u32;
        let mut swap = 0u64;
        let mut rss_anon = 0u64;
        let mut rss_shmem = 0u64;
        let mut vm_rss = 0u64;
        for line in status.lines() {
            if let Some(v) = line.strip_prefix("Uid:") {
                owner = v.split_whitespace().next().and_then(|x| x.parse().ok()).unwrap_or(0);
            } else if let Some(v) = line.strip_prefix("VmSwap:") {
                swap = kb(v);
            } else if let Some(v) = line.strip_prefix("RssAnon:") {
                rss_anon = kb(v);
            } else if let Some(v) = line.strip_prefix("RssShmem:") {
                rss_shmem = kb(v);
            } else if let Some(v) = line.strip_prefix("VmRSS:") {
                vm_rss = kb(v);
            }
        }
        if vm_rss == 0 {
            let statm = read(format!("{base}/statm"));
            let v: Vec<u64> = statm.split_whitespace().filter_map(|x| x.parse().ok()).collect();
            vm_rss = v.get(1).copied().unwrap_or(0) * self.page;
        }
        let mem = if rss_anon > 0 { rss_anon + rss_shmem } else { vm_rss };

        let io = read(format!("{base}/io"));
        let mut rb = 0u64;
        let mut wb = 0u64;
        for line in io.lines() {
            if let Some(v) = line.strip_prefix("read_bytes:") {
                rb = v.trim().parse().unwrap_or(0);
            } else if let Some(v) = line.strip_prefix("write_bytes:") {
                wb = v.trim().parse().unwrap_or(0);
            }
        }

        let prev = self.prev_procs.get(&pid).filter(|p| p.start == start_ticks);
        let (cpu, read_rate, write_rate) = match (prev, have_prev) {
            (Some(p), true) => {
                let dt = ticks.saturating_sub(p.ticks) as f64 / self.clk_tck;
                let cpu = ((dt / elapsed) * 100.0 / self.ncpu as f64).clamp(0.0, 100.0) as f32;
                (
                    cpu,
                    (rb.saturating_sub(p.read) as f64 / elapsed) as u64,
                    (wb.saturating_sub(p.write) as f64 / elapsed) as u64,
                )
            }
            _ => (0.0, 0, 0),
        };

        let raw_cmd = fs::read(format!("{base}/cmdline")).unwrap_or_default();
        let cmd = raw_cmd
            .split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).to_string())
            .collect::<Vec<_>>()
            .join(" ");
        let exe = fs::read_link(format!("{base}/exe"))
            .map(|p| p.to_string_lossy().trim_end_matches(" (deleted)").to_string())
            .unwrap_or_default();

        let app = app_key(&comm, &exe, &cmd);
        let user = self
            .users
            .get(&owner)
            .cloned()
            .unwrap_or_else(|| owner.to_string());

        Some((
            Proc {
                pid,
                ppid,
                name: comm,
                cmd,
                exe,
                app,
                user,
                own: owner == self.my_uid,
                state,
                cpu,
                mem,
                rss: vm_rss,
                swap,
                read_rate,
                write_rate,
                threads,
                nice,
                started: self.boot_time + (start_ticks as f64 / self.clk_tck) as u64,
            },
            PrevProc { ticks, start: start_ticks, read: rb, write: wb },
        ))
    }
}

fn kb(v: &str) -> u64 {
    v.split_whitespace().next().and_then(|x| x.parse::<u64>().ok()).unwrap_or(0) * 1024
}

const INTERPRETERS: &[&str] = &[
    "python", "python2", "python3", "node", "nodejs", "bun", "deno", "perl", "ruby", "php", "bash", "sh",
    "dash", "zsh", "fish", "wine", "wine64", "wine-preloader", "wine64-preloader", "mono", "dotnet",
];

fn app_key(comm: &str, exe: &str, cmd: &str) -> String {
    let base = exe.rsplit('/').next().unwrap_or("");
    let mut key = if base.is_empty() { comm.to_string() } else { base.to_string() };
    let lower = key.to_lowercase();
    let stripped = lower.trim_end_matches(|c: char| c.is_ascii_digit() || c == '.');
    if INTERPRETERS.contains(&stripped) || INTERPRETERS.contains(&lower.as_str()) {
        if let Some(script) = cmd
            .split_whitespace()
            .skip(1)
            .find(|a| !a.starts_with('-') && (a.contains('/') || a.contains('.')))
        {
            let name = script.rsplit('/').next().unwrap_or(script);
            if !name.is_empty() && name.len() < 60 {
                key = format!("{stripped}:{name}");
            }
        }
    }
    if key.starts_with("java") && !key.contains(':') {
        if let Some(jar) = cmd.split_whitespace().skip_while(|a| *a != "-jar").nth(1) {
            key = format!("java:{}", jar.rsplit('/').next().unwrap_or(jar));
        }
    }
    key
}

fn load_users() -> HashMap<u32, String> {
    read("/etc/passwd")
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split(':').collect();
            Some((f.get(2)?.parse().ok()?, f.first()?.to_string()))
        })
        .collect()
}

fn read_net() -> (u64, u64) {
    let mut rx = 0;
    let mut tx = 0;
    for line in read("/proc/net/dev").lines().skip(2) {
        let (iface, data) = match line.split_once(':') {
            Some(x) => x,
            None => continue,
        };
        let iface = iface.trim();
        if iface == "lo" || iface.starts_with("veth") || iface.starts_with("docker") || iface.starts_with("br-") {
            continue;
        }
        let v: Vec<u64> = data.split_whitespace().filter_map(|x| x.parse().ok()).collect();
        rx += v.first().copied().unwrap_or(0);
        tx += v.get(8).copied().unwrap_or(0);
    }
    (rx, tx)
}

pub fn is_physical_disk(name: &str) -> bool {
    if name.starts_with("loop") || name.starts_with("ram") || name.starts_with("zram") || name.starts_with("dm-") || name.starts_with("sr") || name.starts_with("md") {
        return false;
    }
    std::path::Path::new(&format!("/sys/block/{name}")).exists()
}

pub fn read_memory() -> Memory {
    let mut m: HashMap<String, u64> = HashMap::new();
    for line in read("/proc/meminfo").lines() {
        if let Some((k, v)) = line.split_once(':') {
            m.insert(k.to_string(), kb(v));
        }
    }
    let g = |k: &str| m.get(k).copied().unwrap_or(0);
    let total = g("MemTotal");
    let available = g("MemAvailable");
    let shared = g("Shmem");
    let cache = (g("Cached") + g("SReclaimable")).saturating_sub(shared);
    let swaps: Vec<SwapDev> = read("/proc/swaps")
        .lines()
        .skip(1)
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            if f.len() < 5 {
                return None;
            }
            let device = crate::util::unescape_mount(f[0]);
            let dev_name = device.rsplit('/').next().unwrap_or("").to_string();
            let (kind, compressed, original) = if dev_name.starts_with("zram") {
                let mm: Vec<u64> = read(format!("/sys/block/{dev_name}/mm_stat"))
                    .split_whitespace()
                    .filter_map(|x| x.parse().ok())
                    .collect();
                ("Compressed RAM (zram)".to_string(), mm.get(2).copied(), mm.first().copied())
            } else if f[1] == "file" {
                ("Swap file".to_string(), None, None)
            } else {
                ("Swap partition".to_string(), None, None)
            };
            Some(SwapDev {
                device,
                kind,
                size: f[2].parse::<u64>().unwrap_or(0) * 1024,
                used: f[3].parse::<u64>().unwrap_or(0) * 1024,
                priority: f[4].parse().unwrap_or(0),
                compressed,
                original,
            })
        })
        .collect();
    Memory {
        total,
        free: g("MemFree"),
        available,
        used: total.saturating_sub(available),
        cache,
        buffers: g("Buffers"),
        shared,
        slab_reclaimable: g("SReclaimable"),
        dirty: g("Dirty"),
        swap_total: g("SwapTotal"),
        swap_used: g("SwapTotal").saturating_sub(g("SwapFree")),
        swaps,
    }
}

fn cpu_temp() -> Option<f32> {
    let rd = fs::read_dir("/sys/class/hwmon").ok()?;
    let mut fallback = None;
    for e in rd.flatten() {
        let p = e.path();
        let name = read(p.join("name")).trim().to_string();
        let t = read(p.join("temp1_input")).trim().parse::<f32>().ok().map(|v| v / 1000.0);
        if matches!(name.as_str(), "coretemp" | "k10temp" | "zenpower" | "cpu_thermal" | "x86_pkg_temp") {
            if t.is_some() {
                return t;
            }
        }
        if fallback.is_none() && name == "acpitz" {
            fallback = t;
        }
    }
    fallback
}

fn distro_name() -> String {
    read("/etc/os-release")
        .lines()
        .find_map(|l| l.strip_prefix("PRETTY_NAME="))
        .map(|s| s.trim_matches('"').to_string())
        .unwrap_or_else(|| "Linux".into())
}
