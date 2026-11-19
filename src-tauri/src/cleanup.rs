use crate::util::{clear_dir_contents, dir_size, home, mounts, remove_path, run, run_privileged, shell_quote, uid, which};
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

#[derive(Clone)]
enum Kind {
    Remove(Vec<PathBuf>),
    Contents(Vec<PathBuf>),
    Root { script: String, measure: Measure },
}

#[derive(Clone)]
enum Measure {
    Apt,
    Journal,
    OldLogs,
    Crash,
    Files(Vec<PathBuf>),
}

#[derive(Clone)]
pub struct Item {
    id: String,
    group: &'static str,
    title: String,
    description: String,
    selected: bool,
    app: Option<String>,
    kind: Kind,
    pub size: Option<u64>,
    files: u64,
}

#[derive(Serialize, Clone)]
pub struct ItemView {
    pub id: String,
    pub group: String,
    pub title: String,
    pub description: String,
    pub location: String,
    pub size: Option<u64>,
    pub files: u64,
    pub selected: bool,
    pub needs_root: bool,
}

#[derive(Serialize, Clone)]
pub struct CleanResult {
    pub freed: u64,
    pub cleaned: Vec<String>,
    pub errors: Vec<String>,
}

struct CacheInfo {
    dir: &'static str,
    title: &'static str,
    safe: bool,
    app: &'static str,
}

const fn c(dir: &'static str, title: &'static str, safe: bool, app: &'static str) -> CacheInfo {
    CacheInfo { dir, title, safe, app }
}

const KNOWN_CACHES: &[CacheInfo] = &[
    c("google-chrome", "Google Chrome", true, "chrome"),
    c("chromium", "Chromium", true, "chromium"),
    c("BraveSoftware", "Brave", true, "brave"),
    c("mozilla", "Firefox", true, "firefox"),
    c("microsoft-edge", "Microsoft Edge", true, "msedge"),
    c("vivaldi", "Vivaldi", true, "vivaldi-bin"),
    c("opera", "Opera", true, "opera"),
    c("thunderbird", "Thunderbird", true, "thunderbird"),
    c("spotify", "Spotify", true, "spotify"),
    c("pip", "Python pip downloads", true, ""),
    c("pypoetry", "Poetry", true, ""),
    c("uv", "uv (Python)", true, ""),
    c("yarn", "Yarn packages", true, ""),
    c("pnpm", "pnpm", true, ""),
    c("deno", "Deno", true, ""),
    c("go-build", "Go build cache", true, ""),
    c("node-gyp", "node-gyp headers", true, ""),
    c("electron", "Electron downloads", true, ""),
    c("electron-builder", "electron-builder downloads", true, ""),
    c("JetBrains", "JetBrains IDEs", true, ""),
    c("composer", "PHP Composer", true, ""),
    c("fontconfig", "Font cache", true, ""),
    c("mesa_shader_cache", "Graphics shader cache", true, ""),
    c("mesa_shader_cache_db", "Graphics shader cache", true, ""),
    c("nvidia", "NVIDIA shader cache", true, ""),
    c("radv_builtin_shaders", "AMD shader cache", true, ""),
    c("vscode-cpptools", "VS Code C/C++ index", true, ""),
    c("typescript", "TypeScript", true, ""),
    c("gstreamer-1.0", "GStreamer registry", true, ""),
    c("babl", "babl (GIMP)", true, ""),
    c("gimp", "GIMP", true, "gimp"),
    c("tracker3", "File search index", true, ""),
    c("winetricks", "Winetricks downloads", true, ""),
    c("wine", "Wine downloads", true, ""),
    c("ccache", "C/C++ compiler cache", true, ""),
    c("sccache", "Rust/C compiler cache", true, ""),
    c("bazel", "Bazel", true, ""),
    c("cypress", "Cypress test browsers", true, ""),
    c("ms-playwright", "Playwright test browsers (large re-download)", false, ""),
    c("puppeteer", "Puppeteer browsers (re-downloaded when needed)", false, ""),
    c("huggingface", "Hugging Face AI models (large re-download)", false, ""),
    c("torch", "PyTorch models (re-downloaded when needed)", false, ""),
    c("conda", "Conda packages", false, ""),
    c("lutris", "Lutris", false, "lutris"),
    c("flatpak", "Flatpak", true, ""),
    c("discord", "Discord", true, "discord"),
    c("Code", "VS Code", true, "code"),
];

const ELECTRON_CACHE_DIRS: &[&str] = &[
    "Cache",
    "Code Cache",
    "GPUCache",
    "CachedData",
    "DawnCache",
    "DawnWebGPUCache",
    "DawnGraphiteCache",
    "GrShaderCache",
    "ShaderCache",
    "CacheStorage",
    "Crashpad",
    "component_crx_cache",
];

const ELECTRON_SKIP: &[&str] = &[
    "extensions", "node_modules", "IndexedDB", "Local Storage", "Session Storage", "databases", "blob_storage",
    "File System", "Extensions", "Sync Data", "User", "globalStorage", "workspaceStorage",
];

fn is_chromium_profile(dir: &Path) -> bool {
    ["Local State", "GPUCache", "Code Cache", "Preferences", "Cookies"].iter().any(|m| dir.join(m).exists())
}

fn process_alias(app: &str) -> &str {
    match app {
        "google-chrome" | "google-chrome-beta" | "google-chrome-unstable" => "chrome",
        "bravesoftware" => "brave",
        "microsoft-edge" => "msedge",
        "code - oss" => "code-oss",
        "vscodium" => "codium",
        other => other,
    }
}

fn running_names() -> HashSet<String> {
    let mut set = HashSet::new();
    if let Ok(rd) = fs::read_dir("/proc") {
        for e in rd.flatten() {
            let p = e.path();
            if let Ok(comm) = fs::read_to_string(p.join("comm")) {
                set.insert(comm.trim().to_lowercase());
            }
            if let Ok(exe) = fs::read_link(p.join("exe")) {
                if let Some(n) = exe.file_name() {
                    set.insert(n.to_string_lossy().to_lowercase());
                }
            }
        }
    }
    set
}

fn size_of(paths: &[PathBuf]) -> (u64, u64) {
    paths
        .par_iter()
        .map(|p| dir_size(p))
        .reduce(|| (0, 0), |a, b| (a.0 + b.0, a.1 + b.1))
}

fn contents_size(paths: &[PathBuf]) -> (u64, u64) {
    paths
        .par_iter()
        .map(|p| {
            let (s, f) = dir_size(p);
            let own = fs::symlink_metadata(p).map(|m| m.blocks() * 512).unwrap_or(0);
            (s.saturating_sub(own), f)
        })
        .reduce(|| (0, 0), |a, b| (a.0 + b.0, a.1 + b.1))
}

fn title_case(s: &str) -> String {
    let mut out = String::new();
    for (i, part) in s.split(['-', '_']).filter(|p| !p.is_empty()).enumerate() {
        if i > 0 {
            out.push(' ');
        }
        let mut ch = part.chars();
        if let Some(f) = ch.next() {
            out.extend(f.to_uppercase());
            out.push_str(ch.as_str());
        }
    }
    if out.is_empty() {
        s.to_string()
    } else {
        out
    }
}

fn is_rotated_log(name: &str) -> bool {
    if name.ends_with(".gz") || name.ends_with(".xz") || name.ends_with(".bz2") || name.ends_with(".zst") || name.ends_with(".old") {
        return true;
    }
    let trimmed = name.strip_suffix(".log").unwrap_or(name);
    match trimmed.rsplit_once('.') {
        Some((_, n)) => !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()),
        None => false,
    }
}

fn walk_logs(dir: &Path, acc: &mut (u64, u64)) {
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let Ok(m) = e.path().symlink_metadata() else { continue };
            if m.is_dir() {
                if e.file_name() != "journal" {
                    walk_logs(&e.path(), acc);
                }
            } else if m.is_file() && is_rotated_log(&e.file_name().to_string_lossy()) {
                acc.0 += m.blocks() * 512;
                acc.1 += 1;
            }
        }
    }
}

fn parse_human(s: &str) -> u64 {
    let s = s.trim().trim_end_matches('B');
    let (num, mult) = match s.chars().last() {
        Some('K') => (&s[..s.len() - 1], 1u64 << 10),
        Some('M') => (&s[..s.len() - 1], 1 << 20),
        Some('G') => (&s[..s.len() - 1], 1 << 30),
        Some('T') => (&s[..s.len() - 1], 1 << 40),
        _ => (s, 1),
    };
    (num.replace(',', ".").parse::<f64>().unwrap_or(0.0) * mult as f64) as u64
}

const JOURNAL_KEEP: u64 = 200 * 1024 * 1024;

fn measure(m: &Measure) -> (u64, u64) {
    match m {
        Measure::Apt => {
            let mut total = (0, 0);
            for dir in ["/var/cache/apt/archives", "/var/cache/apt/archives/partial"] {
                if let Ok(rd) = fs::read_dir(dir) {
                    for e in rd.flatten() {
                        if let Ok(md) = e.metadata() {
                            if md.is_file() && e.file_name().to_string_lossy().ends_with(".deb") {
                                total.0 += md.blocks() * 512;
                                total.1 += 1;
                            }
                        }
                    }
                }
            }
            for f in ["/var/cache/apt/pkgcache.bin", "/var/cache/apt/srcpkgcache.bin"] {
                if let Ok(md) = fs::metadata(f) {
                    total.0 += md.blocks() * 512;
                }
            }
            total
        }
        Measure::Journal => {
            let out = run("journalctl", &["--disk-usage"]).map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
            let used = out
                .split("take up ")
                .nth(1)
                .and_then(|r| r.split_whitespace().next())
                .map(parse_human)
                .unwrap_or(0);
            (used.saturating_sub(JOURNAL_KEEP), 0)
        }
        Measure::OldLogs => {
            let mut acc = (0, 0);
            walk_logs(Path::new("/var/log"), &mut acc);
            acc
        }
        Measure::Crash => {
            let paths = vec![PathBuf::from("/var/crash"), PathBuf::from("/var/lib/systemd/coredump")];
            contents_size(&paths)
        }
        Measure::Files(p) => size_of(p),
    }
}

fn item_size(kind: &Kind) -> (u64, u64) {
    match kind {
        Kind::Remove(p) => size_of(p),
        Kind::Contents(p) => contents_size(p),
        Kind::Root { measure: m, .. } => measure(m),
    }
}

pub fn compute(item: &Item) -> (u64, u64) {
    item_size(&item.kind)
}

pub fn id_of(item: &Item) -> &str {
    &item.id
}

pub fn set_size(item: &mut Item, size: u64, files: u64) {
    item.size = Some(size);
    item.files = files;
}

pub fn build() -> Vec<Item> {
    let h = home();
    let running = running_names();
    let mut items: Vec<Item> = Vec::new();

    let mut trash_dirs = vec![h.join(".local/share/Trash/files"), h.join(".local/share/Trash/info"), h.join(".local/share/Trash/expunged")];
    trash_dirs.retain(|p| p.exists());
    items.push(Item {
        id: "trash-home".into(),
        group: "Trash",
        title: "Trash".into(),
        description: "Files you already deleted. They still take space until the trash is emptied.".into(),
        selected: true,
        app: None,
        kind: Kind::Contents(trash_dirs),
        size: None,
        files: 0,
    });
    let me = uid();
    for m in mounts() {
        if m.target.starts_with("/media/") || m.target.starts_with("/run/media/") || m.target.starts_with("/mnt/") {
            let t = PathBuf::from(&m.target).join(format!(".Trash-{me}"));
            if t.is_dir() {
                let dirs: Vec<PathBuf> = ["files", "info", "expunged"].iter().map(|d| t.join(d)).filter(|p| p.exists()).collect();
                let name = m.target.rsplit('/').next().unwrap_or(&m.target).to_string();
                items.push(Item {
                    id: format!("trash-{}", m.target),
                    group: "Trash",
                    title: format!("Trash on \"{name}\""),
                    description: format!("Deleted files that are still stored on {}.", m.target),
                    selected: true,
                    app: None,
                    kind: Kind::Contents(dirs),
                    size: None,
                    files: 0,
                });
            }
        }
    }

    items.push(Item {
        id: "thumbnails".into(),
        group: "App caches",
        title: "Picture thumbnails".into(),
        description: "Small previews of your images and videos. They are recreated when you browse folders.".into(),
        selected: true,
        app: None,
        kind: Kind::Remove(vec![h.join(".cache/thumbnails")]),
        size: None,
        files: 0,
    });

    if let Ok(rd) = fs::read_dir(h.join(".cache")) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name == "thumbnails" || !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let known = KNOWN_CACHES.iter().find(|k| k.dir.eq_ignore_ascii_case(&name));
            let (title, description, selected, app) = match known {
                Some(k) if k.safe => (
                    if k.title.to_lowercase().contains("cache") { k.title.to_string() } else { format!("{} cache", k.title) },
                    "Temporary data the app recreates on its own.".to_string(),
                    true,
                    if k.app.is_empty() { None } else { Some(k.app.to_string()) },
                ),
                Some(k) => (
                    k.title.to_string(),
                    "Safe to delete, but it will be downloaded again the next time it is needed.".to_string(),
                    false,
                    None,
                ),
                None => (
                    title_case(&name),
                    "Not a cache we recognise. It may hold an app's working data, so look inside before deleting.".to_string(),
                    false,
                    None,
                ),
            };
            items.push(Item {
                id: format!("cache-{name}"),
                group: if known.is_some() { "App caches" } else { "Other folders in ~/.cache" },
                title,
                description,
                selected,
                app,
                kind: Kind::Remove(vec![e.path()]),
                size: None,
                files: 0,
            });
        }
    }

    if let Ok(rd) = fs::read_dir(h.join(".var/app")) {
        for e in rd.flatten() {
            let cache = e.path().join("cache");
            if !cache.is_dir() {
                continue;
            }
            let id = e.file_name().to_string_lossy().to_string();
            let short = id.rsplit('.').next().unwrap_or(&id).to_string();
            items.push(Item {
                id: format!("flatpak-{id}"),
                group: "App caches",
                title: format!("{} cache (Flatpak)", title_case(&short)),
                description: format!("Temporary data of the Flatpak app {id}."),
                selected: true,
                app: Some(short.to_lowercase()),
                kind: Kind::Contents(vec![cache]),
                size: None,
                files: 0,
            });
        }
    }

    if let Ok(rd) = fs::read_dir(h.join(".config")) {
        for e in rd.flatten() {
            if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            if !is_chromium_profile(&e.path()) {
                continue;
            }
            let mut found = Vec::new();
            find_electron_caches(&e.path(), 0, &mut found);
            if found.is_empty() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            items.push(Item {
                id: format!("electron-{name}"),
                group: "App caches",
                title: format!("{} web cache", title_case(&name)),
                description: "Browser-style cache kept by this app (pages, images, compiled code). Your settings and data are kept.".into(),
                selected: true,
                app: Some(name.to_lowercase()),
                kind: Kind::Remove(found),
                size: None,
                files: 0,
            });
        }
    }

    let dev: &[(&str, &str, &str, &str, bool)] = &[
        ("npm", ".npm/_cacache", "npm download cache", "Packages npm keeps after installing them.", true),
        ("cargo-registry", ".cargo/registry/cache", "Rust crate downloads", "Downloaded crates. Cargo fetches them again when a project needs them.", true),
        ("cargo-src", ".cargo/registry/src", "Unpacked Rust crate sources", "Extracted copies of downloaded crates, recreated automatically.", true),
        ("cargo-git", ".cargo/git/checkouts", "Rust git dependencies", "Checked-out git dependencies, recreated automatically.", true),
        ("gradle", ".gradle/caches", "Gradle cache", "Downloaded Java/Android dependencies and build cache.", true),
        ("maven", ".m2/repository", "Maven downloads", "Java libraries. They are downloaded again on the next build.", false),
        ("nuget", ".nuget/packages", ".NET NuGet packages", "Restored again on the next build.", false),
        ("pnpm-store", ".local/share/pnpm/store", "pnpm package store", "Shared package store. Projects re-link packages on install.", true),
        ("bun", ".bun/install/cache", "Bun package cache", "Packages Bun keeps after installing them.", true),
        ("steam-shaders", ".local/share/Steam/steamapps/shadercache", "Steam shader cache", "Pre-compiled game shaders. Steam rebuilds them.", true),
        ("rustup-downloads", ".rustup/downloads", "Rustup downloads", "Leftover toolchain downloads.", true),
        ("rustup-tmp", ".rustup/tmp", "Rustup temporary files", "Leftovers from toolchain updates.", true),
        ("gradle-wrapper", ".gradle/wrapper/dists", "Gradle versions", "Downloaded Gradle releases, fetched again when needed.", false),
        ("android-avd-cache", ".android/cache", "Android SDK cache", "Temporary Android tool data.", true),
    ];
    for (id, rel, title, desc, sel) in dev {
        let p = h.join(rel);
        if p.exists() {
            items.push(Item {
                id: format!("dev-{id}"),
                group: "Developer caches",
                title: title.to_string(),
                description: desc.to_string(),
                selected: *sel,
                app: None,
                kind: Kind::Remove(vec![p]),
                size: None,
                files: 0,
            });
        }
    }

    if Path::new("/var/cache/apt/archives").is_dir() && which("apt-get") {
        items.push(Item {
            id: "sys-apt".into(),
            group: "System",
            title: "Downloaded software packages".into(),
            description: "Installers APT kept after updates. Installed software is not affected.".into(),
            selected: true,
            app: None,
            kind: Kind::Root { script: "apt-get clean".into(), measure: Measure::Apt },
            size: None,
            files: 0,
        });
    }
    if which("journalctl") {
        items.push(Item {
            id: "sys-journal".into(),
            group: "System",
            title: "Old system logs (journal)".into(),
            description: "System event history. The most recent 200 MB are kept for troubleshooting.".into(),
            selected: true,
            app: None,
            kind: Kind::Root { script: "journalctl --vacuum-size=200M".into(), measure: Measure::Journal },
            size: None,
            files: 0,
        });
    }
    items.push(Item {
        id: "sys-oldlogs".into(),
        group: "System",
        title: "Archived log files".into(),
        description: "Compressed and rotated logs in /var/log. Current logs are kept.".into(),
        selected: true,
        app: None,
        kind: Kind::Root {
            script: "find /var/log -path /var/log/journal -prune -o -type f \\( -name '*.gz' -o -name '*.xz' -o -name '*.bz2' -o -name '*.zst' -o -name '*.old' -o -regex '.*\\.[0-9]+' -o -regex '.*\\.[0-9]+\\.log' \\) -print -delete >/dev/null".into(),
            measure: Measure::OldLogs,
        },
        size: None,
        files: 0,
    });
    items.push(Item {
        id: "sys-crash".into(),
        group: "System",
        title: "Crash reports".into(),
        description: "Memory dumps saved when programs crashed.".into(),
        selected: true,
        app: None,
        kind: Kind::Root {
            script: "rm -rf /var/crash/* /var/lib/systemd/coredump/* 2>/dev/null; true".into(),
            measure: Measure::Crash,
        },
        size: None,
        files: 0,
    });

    if which("snap") {
        if let Some(out) = run("snap", &["list", "--all"]) {
            for line in String::from_utf8_lossy(&out.stdout).lines().skip(1) {
                let f: Vec<&str> = line.split_whitespace().collect();
                if f.len() >= 6 && line.contains("disabled") {
                    let name = f[0];
                    let rev = f[2];
                    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') || !rev.chars().all(|c| c.is_ascii_digit()) {
                        continue;
                    }
                    let file = PathBuf::from(format!("/var/lib/snapd/snaps/{name}_{rev}.snap"));
                    items.push(Item {
                        id: format!("snap-{name}-{rev}"),
                        group: "System",
                        title: format!("Old version of {name} (Snap)"),
                        description: "A previous version Snap keeps after updating. The current version stays.".into(),
                        selected: true,
                        app: None,
                        kind: Kind::Root {
                            script: format!("snap remove {} --revision={}", shell_quote(name), rev),
                            measure: Measure::Files(vec![file]),
                        },
                        size: None,
                        files: 0,
                    });
                }
            }
        }
    }

    for it in items.iter_mut() {
        if let Some(app) = &it.app {
            let lower = app.to_lowercase();
            let a = process_alias(&lower);
            if running.contains(a) || (a.len() > 3 && running.iter().any(|r| r.starts_with(a))) {
                it.selected = false;
                it.description = format!("{} The app is open right now, so close it first.", it.description);
            }
        }
    }
    let order = |g: &str| match g {
        "Trash" => 0,
        "App caches" => 1,
        "Developer caches" => 2,
        "System" => 3,
        _ => 4,
    };
    items.sort_by(|a, b| order(a.group).cmp(&order(b.group)).then(a.title.cmp(&b.title)));
    items
}

fn find_electron_caches(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    if depth > 3 {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if ELECTRON_CACHE_DIRS.contains(&name.as_str()) {
            out.push(e.path());
        } else if depth < 3 && !ELECTRON_SKIP.contains(&name.as_str()) {
            find_electron_caches(&e.path(), depth + 1, out);
        }
    }
}

pub fn view(items: &[Item]) -> Vec<ItemView> {
    let h = home().to_string_lossy().to_string();
    let short = |p: &Path| {
        let s = p.to_string_lossy().to_string();
        if let Some(r) = s.strip_prefix(&h) {
            format!("~{r}")
        } else {
            s
        }
    };
    items
        .iter()
        .filter(|it| it.id == "trash-home" || it.size.map(|s| s >= 64 * 1024).unwrap_or(true))
        .map(|it| {
            let (location, needs_root) = match &it.kind {
                Kind::Remove(p) | Kind::Contents(p) => (
                    match p.len() {
                        0 => String::new(),
                        1 => short(&p[0]),
                        n => {
                            let parent = p[0].parent().map(|x| short(x)).unwrap_or_default();
                            format!("{n} folders in {parent}")
                        }
                    },
                    false,
                ),
                Kind::Root { measure, .. } => (
                    match measure {
                        Measure::Apt => "/var/cache/apt".into(),
                        Measure::Journal => "/var/log/journal".into(),
                        Measure::OldLogs => "/var/log".into(),
                        Measure::Crash => "/var/crash".into(),
                        Measure::Files(p) => p.first().map(|x| x.to_string_lossy().to_string()).unwrap_or_default(),
                    },
                    true,
                ),
            };
            ItemView {
                id: it.id.clone(),
                group: it.group.to_string(),
                title: it.title.clone(),
                description: it.description.clone(),
                location,
                size: it.size,
                files: it.files,
                selected: it.selected,
                needs_root,
            }
        })
        .collect()
}

pub fn clean(items: &[Item], ids: &[String]) -> CleanResult {
    let chosen: Vec<&Item> = items.iter().filter(|i| ids.contains(&i.id)).collect();
    let mut freed = 0u64;
    let mut cleaned = Vec::new();
    let mut errors = Vec::new();
    let mut root_scripts = Vec::new();
    let mut root_items = Vec::new();
    for it in &chosen {
        match &it.kind {
            Kind::Remove(paths) => {
                let mut ok = true;
                for p in paths {
                    if p.exists() {
                        if let Err(e) = remove_path(p) {
                            ok = false;
                            errors.push(format!("{}: {e}", p.display()));
                        }
                    }
                }
                let after = size_of(paths).0;
                freed += it.size.unwrap_or(0).saturating_sub(after);
                if ok {
                    cleaned.push(it.id.clone());
                }
            }
            Kind::Contents(paths) => {
                let mut ok = true;
                for p in paths {
                    let (_, errs) = clear_dir_contents(p);
                    if !errs.is_empty() {
                        ok = false;
                        errors.extend(errs.into_iter().take(5));
                    }
                }
                let after = contents_size(paths).0;
                freed += it.size.unwrap_or(0).saturating_sub(after);
                if ok {
                    cleaned.push(it.id.clone());
                }
            }
            Kind::Root { script, .. } => {
                root_scripts.push(format!("( {script} ) || echo 'failed: {}' >&2", it.title.replace('\'', "")));
                root_items.push(*it);
            }
        }
    }
    if !root_scripts.is_empty() {
        match run_privileged(&root_scripts.join("\n")) {
            Ok(_) => {}
            Err(e) => errors.push(e),
        }
        for it in root_items {
            if let Kind::Root { measure: m, .. } = &it.kind {
                let after = measure(m).0;
                let before = it.size.unwrap_or(0);
                if after < before {
                    freed += before - after;
                    cleaned.push(it.id.clone());
                }
            }
        }
    }
    CleanResult { freed, cleaned, errors }
}
