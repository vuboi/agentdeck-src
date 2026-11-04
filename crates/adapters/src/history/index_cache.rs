//! Index of the Claude and Codex transcripts, kept on disk between starts. A transcript whose length and
//! modified time are unchanged is not read again, so the start-up scan costs one `stat` per file.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde::{de::DeserializeOwned, Deserialize, Serialize};

/// Bump when an indexer's output changes, so every entry is indexed again.
const VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct Entry<T> {
    len: u64,
    modified: u128,
    /// `None` for a file the indexer skipped (no messages), so it is not read again either.
    value: Option<T>,
}

#[derive(Serialize, Deserialize)]
struct Saved<T> {
    version: u32,
    entries: HashMap<String, Entry<T>>,
}

/// Index entries of one kind of file (`T`), read from `path` and written back after a scan.
pub struct IndexCache<T> {
    path: PathBuf,
    saved: HashMap<String, Entry<T>>,
    fresh: HashMap<String, Entry<T>>,
    changed: bool,
}

impl<T: Serialize + DeserializeOwned + Clone> IndexCache<T> {
    /// The entries saved last time. A missing, damaged or older file gives an empty cache.
    pub fn open(path: &Path) -> Self {
        let saved = fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Saved<T>>(&bytes).ok())
            .filter(|saved| saved.version == VERSION)
            .map(|saved| saved.entries)
            .unwrap_or_default();
        Self {
            path: path.to_path_buf(),
            saved,
            fresh: HashMap::new(),
            changed: false,
        }
    }

    /// The indexed value of `file`: the saved one when the file has not changed, otherwise `index` runs.
    pub fn get_or_index(&mut self, file: &Path, index: impl FnOnce() -> Option<T>) -> Option<T> {
        let Ok(meta) = fs::metadata(file) else {
            return index();
        };
        let Some(modified) = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|age| age.as_nanos())
        else {
            return index();
        };
        let len = meta.len();
        let key = file.to_string_lossy().into_owned();
        let value = match self.saved.remove(&key) {
            Some(entry) if entry.len == len && entry.modified == modified => entry.value,
            _ => {
                self.changed = true;
                index()
            }
        };
        self.fresh.insert(
            key,
            Entry {
                len,
                modified,
                value: value.clone(),
            },
        );
        value
    }

    /// Writes this scan's entries. Entries of deleted files are dropped. A failed write only costs the next start a scan.
    pub fn save(self) {
        // Entries left in `saved` belong to files that no longer exist.
        if !self.changed && self.saved.is_empty() {
            return;
        }
        let saved = Saved {
            version: VERSION,
            entries: self.fresh,
        };
        let Ok(bytes) = serde_json::to_vec(&saved) else {
            return;
        };
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let tmp = self.path.with_extension("json.tmp");
        if fs::write(&tmp, bytes).is_ok() {
            let _ = fs::rename(&tmp, &self.path);
        }
    }
}
