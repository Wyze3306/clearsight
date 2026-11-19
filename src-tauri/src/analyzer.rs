use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

const KEEP_FILE: u64 = 1024 * 1024;
const BIG_FILE: u64 = 100 * 1024 * 1024;

struct Node {
    name: String,
    size: u64,
    files: u64,
    is_dir: bool,
    mtime: i64,
    children: Vec<Node>,
    other_size: u64,
    other_count: u64,
}

#[derive(Serialize, Clone)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub files: u64,
    pub is_dir: bool,
    pub is_other: bool,
    pub mtime: i64,
}

#[derive(Serialize, Clone)]
pub struct Listing {
    pub path: String,
    pub root: String,
    pub size: u64,
    pub files: u64,
    pub entries: Vec<Entry>,
}

#[derive(Serialize, Clone)]
pub struct BigFile {
    pub path: String,
    pub size: u64,
    pub mtime: i64,
}

#[derive(Serialize, Clone)]
pub struct Rebuildable {
    pub path: String,
    pub size: u64,
    pub kind: String,
}

#[derive(Serialize, Clone)]
pub struct Status {
    pub decrypted: Vec<String>,
    pub running: bool,
    pub done: bool,
    pub root: String,
    pub files: u64,
    pub bytes: u64,
    pub errors: u64,
    pub current: String,
    pub seconds: f64,
}

#[derive(Default)]
pub struct Scanner {
    running: AtomicBool,
    cancel: AtomicBool,
    files: AtomicU64,
    bytes: AtomicU64,
    errors: AtomicU64,
    current: Mutex<String>,
    root_path: Mutex<String>,
    tree: Mutex<Option<Node>>,
    big: Mutex<Vec<BigFile>>,
    rebuild: Mutex<Vec<Rebuildable>>,
    seen: Mutex<HashSet<(u64, u64)>>,
    started: Mutex<Option<Instant>>,
    seconds: Mutex<f64>,
    see_through: RwLock<Vec<(PathBuf, PathBuf)>>,
    decrypted: Mutex<Vec<String>>,
}

impl Scanner {
    pub fn start(self: &Arc<Self>, root: PathBuf) -> Result<(), String> {
        let meta = fs::metadata(&root).map_err(|e| format!("Cannot open {}: {e}", root.display()))?;
        if !meta.is_dir() {
            return Err(format!("{} is not a folder.", root.display()));
        }
        if self.running.load(Ordering::SeqCst) {
            self.cancel.store(true, Ordering::SeqCst);
            while self.running.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
        self.cancel.store(false, Ordering::SeqCst);
        self.files.store(0, Ordering::SeqCst);
        self.bytes.store(0, Ordering::SeqCst);
        self.errors.store(0, Ordering::SeqCst);
        *self.tree.lock().unwrap() = None;
        self.big.lock().unwrap().clear();
        self.rebuild.lock().unwrap().clear();
        self.seen.lock().unwrap().clear();
        *self.root_path.lock().unwrap() = root.to_string_lossy().to_string();
        let pairs: Vec<(PathBuf, PathBuf)> = crate::util::ecryptfs_pairs()
            .into_iter()
            .filter(|(upper, lower)| {
                fs::metadata(lower).map(|m| m.dev() == meta.dev()).unwrap_or(false)
                    && fs::read_dir(upper).is_ok()
                    && upper.starts_with(&root)
                    && *upper != root
            })
            .collect();
        *self.decrypted.lock().unwrap() = pairs.iter().map(|(u, _)| u.to_string_lossy().to_string()).collect();
        *self.see_through.write().unwrap() = pairs;
        *self.started.lock().unwrap() = Some(Instant::now());
        self.running.store(true, Ordering::SeqCst);
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            let dev = meta.dev();
            let name = root.to_string_lossy().to_string();
            let node = me.scan_dir(&root, name, dev, false, meta.mtime());
            if !me.cancel.load(Ordering::SeqCst) {
                *me.tree.lock().unwrap() = Some(node);
            }
            let secs = me.started.lock().unwrap().map(|s| s.elapsed().as_secs_f64()).unwrap_or(0.0);
            *me.seconds.lock().unwrap() = secs;
            me.running.store(false, Ordering::SeqCst);
        });
        Ok(())
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    pub fn status(&self) -> Status {
        let running = self.running.load(Ordering::SeqCst);
        let seconds = if running {
            self.started.lock().unwrap().map(|s| s.elapsed().as_secs_f64()).unwrap_or(0.0)
        } else {
            *self.seconds.lock().unwrap()
        };
        Status {
            decrypted: self.decrypted.lock().unwrap().clone(),
            running,
            done: self.tree.lock().unwrap().is_some(),
            root: self.root_path.lock().unwrap().clone(),
            files: self.files.load(Ordering::Relaxed),
            bytes: self.bytes.load(Ordering::Relaxed),
            errors: self.errors.load(Ordering::Relaxed),
            current: self.current.lock().unwrap().clone(),
            seconds,
        }
    }

    fn scan_dir(&self, path: &Path, name: String, dev: u64, in_rebuildable: bool, mtime: i64) -> Node {
        let mut node = Node {
            name,
            size: 4096,
            files: 0,
            is_dir: true,
            mtime,
            children: Vec::new(),
            other_size: 0,
            other_count: 0,
        };
        if self.cancel.load(Ordering::Relaxed) {
            return node;
        }
        if let Ok(mut c) = self.current.try_lock() {
            *c = path.to_string_lossy().to_string();
        }
        let entries: Vec<_> = match fs::read_dir(path) {
            Ok(rd) => rd.flatten().collect(),
            Err(_) => {
                self.errors.fetch_add(1, Ordering::Relaxed);
                return node;
            }
        };
        let dir_name = path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let mut kind: Option<&str> = None;
        if !in_rebuildable {
            if dir_name == "node_modules" {
                kind = Some("Node.js packages (npm install restores them)");
            } else if entries.iter().any(|e| e.file_name() == "CACHEDIR.TAG") {
                kind = Some(if entries.iter().any(|e| e.file_name() == ".rustc_info.json") {
                    "Rust build output (cargo build recreates it)"
                } else {
                    "Build or cache folder (marked as safe to delete)"
                });
            } else if entries.iter().any(|e| e.file_name() == "pyvenv.cfg") {
                kind = Some("Python virtual environment (can be recreated)");
            }
        }
        let inside = in_rebuildable || kind.is_some();

        let mut subdirs = Vec::new();
        for e in &entries {
            let meta = match e.path().symlink_metadata() {
                Ok(m) => m,
                Err(_) => {
                    self.errors.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
            };
            if meta.is_dir() {
                let p = e.path();
                let name = e.file_name().to_string_lossy().to_string();
                if meta.dev() == dev {
                    let hides_lower = self.see_through.read().unwrap().iter().any(|(_, lower)| *lower == p);
                    if !hides_lower {
                        subdirs.push((p, name, meta.mtime(), dev));
                    }
                } else if self.see_through.read().unwrap().iter().any(|(upper, _)| *upper == p) {
                    let real = fs::metadata(&p).map(|m| m.dev()).unwrap_or(meta.dev());
                    subdirs.push((p, name, meta.mtime(), real));
                }
                continue;
            }
            let mut size = meta.blocks() * 512;
            if meta.nlink() > 1 && meta.is_file() {
                let key = (meta.dev(), meta.ino());
                if !self.seen.lock().unwrap().insert(key) {
                    size = 0;
                }
            }
            node.size += size;
            node.files += 1;
            self.files.fetch_add(1, Ordering::Relaxed);
            self.bytes.fetch_add(size, Ordering::Relaxed);
            if size >= KEEP_FILE {
                let fname = e.file_name().to_string_lossy().to_string();
                if size >= BIG_FILE {
                    self.big.lock().unwrap().push(BigFile {
                        path: e.path().to_string_lossy().to_string(),
                        size,
                        mtime: meta.mtime(),
                    });
                }
                node.children.push(Node {
                    name: fname,
                    size,
                    files: 1,
                    is_dir: false,
                    mtime: meta.mtime(),
                    children: Vec::new(),
                    other_size: 0,
                    other_count: 0,
                });
            } else {
                node.other_size += size;
                node.other_count += 1;
            }
        }

        let children: Vec<Node> = subdirs
            .into_par_iter()
            .map(|(p, n, m, d)| self.scan_dir(&p, n, d, inside, m))
            .collect();
        for c in children {
            node.size += c.size;
            node.files += c.files;
            node.children.push(c);
        }
        node.children.sort_by(|a, b| b.size.cmp(&a.size));
        if let Some(k) = kind {
            if node.size > 1024 * 1024 {
                self.rebuild.lock().unwrap().push(Rebuildable {
                    path: path.to_string_lossy().to_string(),
                    size: node.size,
                    kind: k.to_string(),
                });
            }
        }
        node
    }

    pub fn list(&self, path: &str) -> Result<Listing, String> {
        let root = self.root_path.lock().unwrap().clone();
        let guard = self.tree.lock().unwrap();
        let tree = guard.as_ref().ok_or("No scan results yet.")?;
        let rel = Path::new(path).strip_prefix(&root).map_err(|_| "This folder is outside the scanned location.")?;
        let mut node = tree;
        for comp in rel.components() {
            let c = comp.as_os_str().to_string_lossy();
            node = node
                .children
                .iter()
                .find(|n| n.is_dir && n.name == c)
                .ok_or("This folder is not in the scan results.")?;
        }
        let base = PathBuf::from(path);
        let mut entries: Vec<Entry> = node
            .children
            .iter()
            .take(400)
            .map(|c| Entry {
                name: c.name.clone(),
                path: base.join(&c.name).to_string_lossy().to_string(),
                size: c.size,
                files: c.files,
                is_dir: c.is_dir,
                is_other: false,
                mtime: c.mtime,
            })
            .collect();
        if node.other_count > 0 {
            entries.push(Entry {
                name: format!("{} smaller files", node.other_count),
                path: String::new(),
                size: node.other_size,
                files: node.other_count,
                is_dir: false,
                is_other: true,
                mtime: 0,
            });
            entries.sort_by(|a, b| b.size.cmp(&a.size));
        }
        Ok(Listing { path: path.to_string(), root, size: node.size, files: node.files, entries })
    }

    pub fn big_files(&self) -> Vec<BigFile> {
        let mut v = self.big.lock().unwrap().clone();
        v.retain(|f| Path::new(&f.path).exists());
        v.sort_by(|a, b| b.size.cmp(&a.size));
        v.truncate(300);
        v
    }

    pub fn rebuildable(&self) -> Vec<Rebuildable> {
        let mut v = self.rebuild.lock().unwrap().clone();
        v.retain(|f| Path::new(&f.path).exists());
        v.sort_by(|a, b| b.size.cmp(&a.size));
        v.truncate(300);
        v
    }

    pub fn forget(&self, path: &str) {
        self.big.lock().unwrap().retain(|f| !(f.path == path || f.path.starts_with(&format!("{path}/"))));
        self.rebuild.lock().unwrap().retain(|f| !(f.path == path || f.path.starts_with(&format!("{path}/"))));
        let root = self.root_path.lock().unwrap().clone();
        let mut guard = self.tree.lock().unwrap();
        let tree = match guard.as_mut() {
            Some(t) => t,
            None => return,
        };
        let rel = match Path::new(path).strip_prefix(&root) {
            Ok(r) => r,
            Err(_) => return,
        };
        let comps: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect();
        if comps.is_empty() {
            return;
        }
        fn remove(node: &mut Node, comps: &[String]) -> Option<(u64, u64)> {
            if comps.len() == 1 {
                let idx = node.children.iter().position(|c| c.name == comps[0])?;
                let gone = node.children.remove(idx);
                node.size = node.size.saturating_sub(gone.size);
                node.files = node.files.saturating_sub(gone.files);
                return Some((gone.size, gone.files));
            }
            let child = node.children.iter_mut().find(|c| c.is_dir && c.name == comps[0])?;
            let (s, f) = remove(child, &comps[1..])?;
            node.size = node.size.saturating_sub(s);
            node.files = node.files.saturating_sub(f);
            Some((s, f))
        }
        remove(tree, &comps);
    }
}
