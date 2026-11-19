<p align="center">
  <img src="assets/icon-1024.png" width="112" alt="Clearsight icon">
</p>

<h1 align="center">Clearsight</h1>

<p align="center">
  See everything your Linux machine is doing, and clean it up in one click.
</p>

<p align="center">
  <a href="https://github.com/Wyze3306/clearsight/releases/latest">Download</a> ·
  <a href="#features">Features</a> ·
  <a href="#install">Install</a> ·
  <a href="#build-from-source">Build from source</a>
</p>

---

Clearsight is a task manager, storage analyzer and cleaner for Linux, built for people who want straight answers:
*what is slowing my computer down, where did my disk space go, and what can I safely delete?*

It speaks plain English instead of raw numbers. When something is wrong, the overview tells you what it is and
offers the button that fixes it.

## Features

### Overview
- A one-line verdict on the health of your computer ("Your drive is almost full and memory is running short.").
- Actionable cards: drive almost full, memory pressure, heavy swap use, a runaway app, a hot processor, paused apps.
- Live processor, memory and drive tiles, network and disk activity, top apps by processor and by memory.

### Apps & processes
- **Apps view**: processes are grouped into the app they belong to, with the real app name and icon
  (Chrome's 40 helper processes show up as one "Google Chrome" row). Java, Python and Node.js programs are
  named after the jar or script they run.
- **All processes view** with PID and user.
- Sort by processor, memory, **swap**, disk activity, name, PID or user. The table keeps still while your mouse is on it.
- Search by app name, command line or PID.
- Details panel: memory, swap, disk, threads, priority, start time, executable and full command line.
- Actions: **End app**, **Force quit**, **Pause / Resume**, **Lower priority**, **Open program folder**.
  Processes owned by root or another user can be handled with your administrator password.
- Warnings before ending parts of your desktop session.
- Keyboard: <kbd>1</kbd>–<kbd>5</kbd> switch sections, <kbd>/</kbd> or <kbd>Ctrl</kbd>+<kbd>F</kbd> search,
  <kbd>↑</kbd> <kbd>↓</kbd> move, <kbd>→</kbd> <kbd>←</kbd> expand, <kbd>Delete</kbd> end, <kbd>Shift</kbd>+<kbd>Delete</kbd> force quit.

### Memory
- A clear breakdown: used by apps, shared and in-memory files (`/tmp`, `/dev/shm`), cache, free.
- Apps ranked by memory **plus swap**, with an End button on each.
- Every swap device, including **zram** with its real compression ratio.
- **Move swap back into memory** (only offered when there is enough free RAM), **clear the file cache**,
  and a shortcut to files that sit in RAM-backed folders.

### Storage
- Every drive and partition explained layer by layer:
  physical disk › partition › LVM volume › LUKS container › file system.
- **Encrypted setups made understandable.** An eCryptfs home folder is shown for what it is: an encrypted folder
  stored inside your system partition, sharing the same free space. LUKS full-disk encryption is detected too.
- Spots the **5% ext4 reserved space** on large drives and can lower it to 1% (often 15–20 GB back on a 500 GB drive).
- A partition map of each physical drive, and the folders that live in RAM.
- **What uses space**: a fast, parallel folder scanner (home, system, external drives or any folder) with
  - drill-down folder sizes with plain explanations for well-known folders,
  - the largest files on the drive,
  - **rebuildable folders**: `node_modules`, Rust `target` folders, Python virtual environments and other
    folders tagged as caches, which your tools recreate on their own.
  - Delete permanently (frees space now) or move to the Trash. System folders and your settings are protected.

### Clean up
- Scans in seconds and keeps measuring in the background, so the list appears right away.
- **Trash** (including trash folders on external drives).
- **App caches**: thumbnails, browsers, Spotify, Flatpak app caches, Electron and Chromium-based app caches,
  shader caches and more. Caches of apps that are open right now are left unselected.
- **Developer caches**: npm, Cargo, Gradle, Maven, NuGet, pnpm, Bun, pip, Go, Yarn, Steam shader cache…
- **System**: downloaded APT packages, old journal logs (keeps the last 200 MB), archived logs, crash reports,
  old Snap revisions. All administrator tasks run in a single password prompt.
- Only safe items are selected by default. Folders in `~/.cache` that are not recognised are listed separately and
  never pre-selected, because some tools keep real work there.

### Private by design
Clearsight never connects to the internet. Everything is read locally from `/proc`, `/sys` and your file system.
Administrator actions go through `pkexec`, so you always see the system password prompt first.

## Install

Grab the latest files from the [Releases page](https://github.com/Wyze3306/clearsight/releases/latest).

**Debian, Ubuntu, Linux Mint, Pop!_OS and derivatives**

```bash
sudo apt install ./Clearsight_1.0.0_amd64.deb
```

**Any other distribution (AppImage)**

```bash
chmod +x Clearsight_1.0.0_amd64.AppImage
./Clearsight_1.0.0_amd64.AppImage
```

Requirements: a 64-bit Linux desktop with WebKitGTK 4.1 (installed automatically with the `.deb`, bundled in the AppImage).
Administrator actions need `pkexec` (polkit), which every mainstream desktop ships.

## Build from source

```bash
sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev build-essential curl
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
git clone https://github.com/Wyze3306/clearsight.git
cd clearsight
npm ci
npx tauri build
```

The packages land in `src-tauri/target/release/bundle/`. Use `npx tauri dev` while working on it.

### Project layout

| Path | What it holds |
| --- | --- |
| `src-tauri/src/system.rs` | Processor, memory, swap, disk and network sampling straight from `/proc` |
| `src-tauri/src/apps.rs` | Matches processes to installed apps (names and icons from `.desktop` files) |
| `src-tauri/src/storage.rs` | Drive layout from `lsblk`, encryption and LVM detection, eCryptfs mapping |
| `src-tauri/src/analyzer.rs` | Parallel folder scanner, largest files, rebuildable folders |
| `src-tauri/src/cleanup.rs` | Cleanup catalogue, background measuring and cleaning |
| `ui/` | The interface: plain HTML, CSS and JavaScript modules, no framework |

## License

[MIT](LICENSE)
