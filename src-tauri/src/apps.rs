use crate::util::{base64, home, read};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone)]
pub struct AppInfo {
    pub name: String,
    pub icon: Option<String>,
}

#[derive(Clone)]
struct Entry {
    name: String,
    icon: String,
}

pub struct AppDirectory {
    by_key: HashMap<String, Entry>,
    by_norm: HashMap<String, Entry>,
    icon_cache: HashMap<String, Option<String>>,
    icon_dirs: Vec<PathBuf>,
}

fn data_dirs() -> Vec<PathBuf> {
    let h = home();
    let mut dirs = vec![
        h.join(".local/share"),
        h.join(".local/share/flatpak/exports/share"),
        PathBuf::from("/var/lib/flatpak/exports/share"),
        PathBuf::from("/var/lib/snapd/desktop"),
        PathBuf::from("/usr/local/share"),
        PathBuf::from("/usr/share"),
    ];
    if let Ok(x) = std::env::var("XDG_DATA_DIRS") {
        for d in x.split(':').filter(|d| !d.is_empty() && !d.contains("/tmp/.mount_")) {
            let p = PathBuf::from(d);
            if !dirs.contains(&p) {
                dirs.push(p);
            }
        }
    }
    dirs
}

impl AppDirectory {
    pub fn load() -> Self {
        let mut by_key: HashMap<String, Entry> = HashMap::new();
        let mut icon_dirs = Vec::new();
        for dir in data_dirs() {
            let apps = dir.join("applications");
            if let Ok(rd) = fs::read_dir(&apps) {
                for e in rd.flatten() {
                    let p = e.path();
                    if p.extension().and_then(|x| x.to_str()) != Some("desktop") {
                        continue;
                    }
                    parse_desktop(&p, &mut by_key);
                }
            }
            let icons = dir.join("icons");
            for theme in ["hicolor", "Mint-Y", "Adwaita", "breeze", "Papirus"] {
                for size in ["48x48", "64x64", "128x128", "256x256", "96x96", "32x32", "scalable", "512x512"] {
                    let d = icons.join(theme).join(size).join("apps");
                    if d.is_dir() {
                        icon_dirs.push(d);
                    }
                }
                for size in ["48", "64", "96", "128", "256"] {
                    let d = icons.join(theme).join("apps").join(size);
                    if d.is_dir() {
                        icon_dirs.push(d);
                    }
                }
            }
            let pix = dir.join("pixmaps");
            if pix.is_dir() {
                icon_dirs.push(pix);
            }
        }
        let local_icons = home().join(".icons");
        if local_icons.is_dir() {
            icon_dirs.push(local_icons);
        }
        let mut by_norm = HashMap::new();
        for (k, v) in &by_key {
            by_norm.entry(normalize(k)).or_insert_with(|| v.clone());
        }
        AppDirectory { by_key, by_norm, icon_cache: HashMap::new(), icon_dirs }
    }

    pub fn lookup(&mut self, key: &str) -> AppInfo {
        let known = pretty_name(key);
        let entry = if key.contains(':') {
            None
        } else if known != key && !self.by_key.contains_key(&key.to_lowercase()) {
            None
        } else {
            self.find(key)
        };
        match entry {
            Some(e) => {
                let icon = self.icon(&e.icon);
                AppInfo { name: if known != key { known } else { e.name }, icon }
            }
            None => AppInfo { name: known, icon: None },
        }
    }

    fn find(&self, key: &str) -> Option<Entry> {
        let lower = key.to_lowercase();
        if let Some(e) = self.by_key.get(&lower) {
            return Some(e.clone());
        }
        let norm = normalize(&lower);
        if norm.len() < 3 {
            return None;
        }
        if let Some(e) = self.by_norm.get(&norm) {
            return Some(e.clone());
        }
        if norm.len() >= 4 && pretty_name(key) == key {
            return self
                .by_norm
                .iter()
                .filter(|(k, _)| k.starts_with(&norm))
                .min_by_key(|(k, _)| k.len())
                .map(|(_, e)| e.clone());
        }
        None
    }

    fn icon(&mut self, name: &str) -> Option<String> {
        if name.is_empty() {
            return None;
        }
        if let Some(c) = self.icon_cache.get(name) {
            return c.clone();
        }
        let path = if name.starts_with('/') {
            Some(PathBuf::from(name)).filter(|p| p.is_file())
        } else {
            self.icon_dirs.iter().find_map(|d| {
                ["png", "svg", "xpm"]
                    .iter()
                    .map(|ext| d.join(format!("{name}.{ext}")))
                    .find(|p| p.is_file())
            })
        };
        let data = path.and_then(|p| encode_icon(&p));
        self.icon_cache.insert(name.to_string(), data.clone());
        data
    }
}

fn normalize(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_lowercase()
}

fn encode_icon(p: &Path) -> Option<String> {
    let ext = p.extension()?.to_str()?.to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "svg" => "image/svg+xml",
        _ => return None,
    };
    let bytes = fs::read(p).ok()?;
    if bytes.len() > 600_000 {
        return None;
    }
    Some(format!("data:{mime};base64,{}", base64(&bytes)))
}

fn parse_desktop(path: &Path, map: &mut HashMap<String, Entry>) {
    let text = read(path);
    let mut in_main = false;
    let mut name = String::new();
    let mut icon = String::new();
    let mut exec = String::new();
    let mut wmclass = String::new();
    let mut flatpak = String::new();
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_main = line == "[Desktop Entry]";
            continue;
        }
        if !in_main {
            continue;
        }
        if let Some(v) = line.strip_prefix("Name=") {
            if name.is_empty() {
                name = v.to_string();
            }
        } else if let Some(v) = line.strip_prefix("Icon=") {
            icon = v.to_string();
        } else if let Some(v) = line.strip_prefix("Exec=") {
            exec = v.to_string();
        } else if let Some(v) = line.strip_prefix("StartupWMClass=") {
            wmclass = v.to_string();
        } else if let Some(v) = line.strip_prefix("X-Flatpak=") {
            flatpak = v.to_string();
        }
    }
    if name.is_empty() {
        return;
    }
    let entry = Entry { name, icon };
    let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
    let mut keys: Vec<String> = Vec::new();
    let tokens: Vec<&str> = exec.split_whitespace().collect();
    let mut i = 0;
    if tokens.first() == Some(&"env") {
        i = 1;
        while i < tokens.len() && tokens[i].contains('=') {
            i += 1;
        }
    }
    let is_web_app = exec.contains("--app-id") || exec.contains("--app=") || exec.contains("--profile-directory=") && id.contains('-') && id.len() > 30;
    if is_web_app {
        map.entry(id).or_insert(entry);
        return;
    }
    if let Some(prog) = tokens.get(i) {
        let prog = prog.trim_matches('"');
        let base = prog.rsplit('/').next().unwrap_or(prog).to_lowercase();
        if !matches!(base.as_str(), "flatpak" | "sh" | "bash" | "env" | "python3" | "java" | "snap" | "wine") {
            keys.push(base);
        }
    }
    if !wmclass.is_empty() {
        keys.push(wmclass.to_lowercase());
    }
    if !flatpak.is_empty() {
        keys.push(flatpak.to_lowercase());
        if let Some(last) = flatpak.rsplit('.').next() {
            keys.push(last.to_lowercase());
        }
    }
    if let Some(last) = id.rsplit('.').next() {
        keys.push(last.to_string());
    }
    keys.push(id);
    for k in keys {
        if k.is_empty() {
            continue;
        }
        map.entry(k).or_insert_with(|| entry.clone());
    }
}

fn pretty_name(key: &str) -> String {
    if let Some((interp, script)) = key.split_once(':') {
        let label = match interp {
            "java" => "Java",
            "node" | "nodejs" => "Node.js",
            "python" | "python2" | "python3" => "Python",
            "wine" | "wine64" | "wine-preloader" | "wine64-preloader" => "Wine",
            "bash" | "sh" | "dash" | "zsh" | "fish" => "Script",
            other => other,
        };
        return format!("{script} ({label})");
    }
    const KNOWN: &[(&str, &str)] = &[
        ("Xorg", "Display server (Xorg)"),
        ("Xwayland", "Display server (Xwayland)"),
        ("systemd", "System manager (systemd)"),
        ("systemd-journald", "System logs (journald)"),
        ("pipewire", "Audio server (PipeWire)"),
        ("pipewire-pulse", "Audio server (PipeWire Pulse)"),
        ("wireplumber", "Audio session manager"),
        ("pulseaudio", "Audio server (PulseAudio)"),
        ("NetworkManager", "Network manager"),
        ("cinnamon", "Cinnamon desktop"),
        ("gnome-shell", "GNOME desktop"),
        ("plasmashell", "KDE Plasma desktop"),
        ("kwin_x11", "KDE window manager"),
        ("kwin_wayland", "KDE window manager"),
        ("nemo", "Files (Nemo)"),
        ("nemo-desktop", "Desktop icons (Nemo)"),
        ("dockerd", "Docker engine"),
        ("containerd", "Container runtime"),
        ("sshd", "SSH server"),
        ("cupsd", "Printing service"),
        ("bwrap", "Sandboxed app (bubblewrap)"),
        ("java", "Java"),
        ("node", "Node.js"),
        ("python3", "Python"),
        ("bash", "Terminal shell (bash)"),
        ("zsh", "Terminal shell (zsh)"),
        ("fish", "Terminal shell (fish)"),
        ("clearsight", "Clearsight"),
        ("WebKitWebProcess", "Web view process"),
        ("WebKitNetworkProcess", "Web view network process"),
    ];
    for (k, v) in KNOWN {
        if *k == key {
            return v.to_string();
        }
    }
    key.to_string()
}
