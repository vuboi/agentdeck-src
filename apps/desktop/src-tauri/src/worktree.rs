//! Git worktrees for chats: one isolated checkout and branch per parallel task, under `<repo>/.agentdeck/worktrees/`.
//! Merging back is always an explicit user action, and a conflict stops the merge (it is aborted, never auto-resolved).

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::changes::{git, git_ok, toplevel};

/// The folder inside the repository that holds worktrees. Added to `.git/info/exclude` so it never shows as changes.
const DIR: &str = ".agentdeck/worktrees";

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    pub base: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    pub dirty_files: u32,
    /// Commits on the worktree branch that the base does not have.
    pub ahead: u32,
    /// Commits on the base that the worktree branch does not have.
    pub behind: u32,
}

/// A slug is a short lowercase word: it names a folder and a branch.
pub fn checked_slug(slug: &str) -> Result<&str, String> {
    let ok = !slug.is_empty()
        && slug.len() <= 24
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !slug.starts_with('-')
        && !slug.ends_with('-');
    if ok {
        Ok(slug)
    } else {
        Err("worktree name: use 1-24 lowercase letters, digits or '-'".to_string())
    }
}

/// `<slug>-<4 hex>`: unique enough per chat and short enough for a Windows path.
fn unique_name(slug: &str) -> String {
    // A counter per process plus the pid: two worktrees made in the same nanosecond (parallel tests, two workers) still differ.
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mix = std::process::id().wrapping_mul(131).wrapping_add(n);
    format!("{slug}-{:04x}", mix & 0xffff)
}

fn exclude_worktree_dir(top: &Path) -> Result<(), String> {
    let common = git_ok(top, &["rev-parse", "--git-common-dir"])?;
    let common = String::from_utf8_lossy(&common).trim().to_string();
    let common = if Path::new(&common).is_absolute() {
        PathBuf::from(&common)
    } else {
        top.join(&common)
    };
    let file = common.join("info").join("exclude");
    let existing = std::fs::read_to_string(&file).unwrap_or_default();
    if !existing.lines().any(|line| line.trim() == ".agentdeck/") {
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut next = existing;
        if !next.is_empty() && !next.ends_with('\n') {
            next.push('\n');
        }
        next.push_str(".agentdeck/\n");
        std::fs::write(&file, next).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Creates a worktree on a new branch from `base`. Returns its path and branch.
pub fn create(root: &str, slug: &str, base: &str) -> Result<WorktreeInfo, String> {
    let slug = checked_slug(slug)?;
    let top = toplevel(root)?;
    exclude_worktree_dir(&top)?;
    let name = unique_name(slug);
    let branch = format!("agentdeck/{name}");
    let path = top.join(DIR).join(&name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let path_text = path.to_string_lossy().to_string();
    git_ok(&top, &["worktree", "add", "-b", &branch, &path_text, base])?;
    Ok(WorktreeInfo {
        path: path_text,
        branch,
        base: base.to_string(),
    })
}

/// Status of one worktree compared with its base.
pub fn status(path: &str, base: &str) -> Result<WorktreeStatus, String> {
    let dir = Path::new(path);
    let dirty = git_ok(dir, &["status", "--porcelain"])?;
    let dirty_files = String::from_utf8_lossy(&dirty)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .count() as u32;
    let counts = git_ok(
        dir,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("{base}...HEAD"),
        ],
    )?;
    let text = String::from_utf8_lossy(&counts).to_string();
    let mut parts = text
        .split_whitespace()
        .map(|p| p.parse::<u32>().unwrap_or(0));
    let behind = parts.next().unwrap_or(0);
    let ahead = parts.next().unwrap_or(0);
    Ok(WorktreeStatus {
        dirty_files,
        ahead,
        behind,
    })
}

/// Worktrees of the repository that AgentDeck created (under `DIR`).
pub fn list(root: &str) -> Result<Vec<String>, String> {
    let top = toplevel(root)?;
    let out = git_ok(&top, &["worktree", "list", "--porcelain"])?;
    Ok(String::from_utf8_lossy(&out)
        .lines()
        .filter_map(|l| l.strip_prefix("worktree "))
        .filter(|p| p.replace('\\', "/").contains(&format!("/{DIR}/")))
        .map(str::to_string)
        .collect())
}

/// Commits everything in a worktree (the worker's uncommitted files) with `message`. Fails when there is nothing to commit.
pub fn commit(path: &str, message: &str) -> Result<(), String> {
    let dir = Path::new(path);
    git_ok(dir, &["add", "-A"])?;
    git_ok(dir, &["commit", "-qm", message]).map(|_| ())
}

/// Merges the worktree's branch into `base`, which must be the branch checked out at `root`. Refuses when `root` is on another
/// branch or has local changes. A conflict aborts the merge and returns git's message; nothing is resolved automatically.
pub fn merge(root: &str, branch: &str, base: &str) -> Result<(), String> {
    let top = toplevel(root)?;
    let head = git_ok(&top, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let head = String::from_utf8_lossy(&head).trim().to_string();
    if head != base {
        return Err(format!(
            "the main checkout is on {head}, not {base}: check out {base} before merging"
        ));
    }
    let dirty = git_ok(&top, &["status", "--porcelain"])?;
    if !dirty.is_empty() {
        return Err(
            "the main checkout has local changes: commit or stash them before merging".to_string(),
        );
    }
    let (ok, _, stderr) = git(&top, &["merge", "--no-edit", "--no-ff", branch])?;
    if ok {
        return Ok(());
    }
    let _ = git(&top, &["merge", "--abort"]);
    Err(if stderr.is_empty() {
        "merge failed".to_string()
    } else {
        stderr
    })
}

/// Removes a worktree. Refuses local changes unless `force`. The branch is deleted only when merged, unless `force`.
pub fn remove(root: &str, path: &str, branch: &str, force: bool) -> Result<(), String> {
    let top = toplevel(root)?;
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(path);
    git_ok(&top, &args)?;
    let flag = if force { "-D" } else { "-d" };
    git_ok(&top, &["branch", flag, branch]).map(|_| ())
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn worktree_create(
    root: String,
    slug: String,
    base: String,
) -> Result<WorktreeInfo, String> {
    blocking(move || create(&root, &slug, &base)).await
}

#[tauri::command]
pub async fn worktree_status(path: String, base: String) -> Result<WorktreeStatus, String> {
    blocking(move || status(&path, &base)).await
}

#[tauri::command]
pub async fn worktree_list(root: String) -> Result<Vec<String>, String> {
    blocking(move || list(&root)).await
}

#[tauri::command]
pub async fn worktree_merge(root: String, branch: String, base: String) -> Result<(), String> {
    blocking(move || merge(&root, &branch, &base)).await
}

#[tauri::command]
pub async fn worktree_commit(path: String, message: String) -> Result<(), String> {
    blocking(move || commit(&path, &message)).await
}

#[tauri::command]
pub async fn worktree_remove(
    root: String,
    path: String,
    branch: String,
    force: bool,
) -> Result<(), String> {
    blocking(move || remove(&root, &path, &branch, force)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("agentdeck-wt-{}", unique_name("t")));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.to_string_lossy().to_string();
        git_ok(&dir, &["init", "-q", "-b", "main"]).unwrap();
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git_ok(&dir, &["add", "."]).unwrap();
        git_ok(
            &dir,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-qm",
                "init",
            ],
        )
        .unwrap();
        let _ = p;
        dir
    }

    fn commit_all(dir: &Path, msg: &str) {
        git_ok(dir, &["add", "."]).unwrap();
        git_ok(
            dir,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-qm",
                msg,
            ],
        )
        .unwrap();
    }

    #[test]
    fn slugs_are_short_plain_words() {
        assert!(checked_slug("fix-export").is_ok());
        assert!(checked_slug("").is_err());
        assert!(checked_slug("-bad").is_err());
        assert!(checked_slug("Has Space").is_err());
        assert!(checked_slug(&"a".repeat(25)).is_err());
    }

    #[test]
    fn create_status_merge_remove_round_trip() {
        let root = repo();
        let r = root.to_string_lossy().to_string();

        let wt = create(&r, "export", "main").unwrap();
        assert!(wt.branch.starts_with("agentdeck/export-"));
        assert!(Path::new(&wt.path).join("a.txt").exists());
        let listed = list(&r).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(Path::new(&listed[0]), Path::new(&wt.path));

        // A change in the worktree: dirty, then committed: ahead by one.
        std::fs::write(Path::new(&wt.path).join("b.txt"), "two\n").unwrap();
        let s = status(&wt.path, "main").unwrap();
        assert_eq!(
            s,
            WorktreeStatus {
                dirty_files: 1,
                ahead: 0,
                behind: 0
            }
        );
        commit_all(Path::new(&wt.path), "add b");
        let s = status(&wt.path, "main").unwrap();
        assert_eq!(
            s,
            WorktreeStatus {
                dirty_files: 0,
                ahead: 1,
                behind: 0
            }
        );

        // Merge refuses while the main checkout is dirty.
        std::fs::write(root.join("dirty.txt"), "x").unwrap();
        assert!(merge(&r, &wt.branch, "main").is_err());
        std::fs::remove_file(root.join("dirty.txt")).unwrap();

        merge(&r, &wt.branch, "main").unwrap();
        assert!(root.join("b.txt").exists());

        remove(&r, &wt.path, &wt.branch, false).unwrap();
        assert!(list(&r).unwrap().is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn remove_refuses_dirty_worktree_and_unmerged_branch() {
        let root = repo();
        let r = root.to_string_lossy().to_string();
        let wt = create(&r, "work", "main").unwrap();
        std::fs::write(Path::new(&wt.path).join("c.txt"), "3\n").unwrap();
        assert!(remove(&r, &wt.path, &wt.branch, false).is_err());
        commit_all(Path::new(&wt.path), "c");
        // Committed but not merged: branch delete refuses, the worktree itself is gone.
        assert!(remove(&r, &wt.path, &wt.branch, false).is_err());
        assert!(!git_ok(&root, &["branch", "--list", &wt.branch])
            .unwrap()
            .is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn merge_refuses_unless_the_checkout_is_on_base() {
        let root = repo();
        let r = root.to_string_lossy().to_string();
        let wt = create(&r, "onbase", "main").unwrap();
        std::fs::write(Path::new(&wt.path).join("b.txt"), "two\n").unwrap();
        commit_all(Path::new(&wt.path), "add b");
        git_ok(&root, &["checkout", "-qb", "other"]).unwrap();
        let err = merge(&r, &wt.branch, "main").unwrap_err();
        assert!(err.contains("not main"), "{err}");
        assert!(!root.join("b.txt").exists());
        git_ok(&root, &["checkout", "-q", "main"]).unwrap();
        merge(&r, &wt.branch, "main").unwrap();
        assert!(root.join("b.txt").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn commit_takes_the_worktree_changes_and_fails_when_there_are_none() {
        let root = repo();
        let r = root.to_string_lossy().to_string();
        let wt = create(&r, "cm", "main").unwrap();
        git_ok(Path::new(&wt.path), &["config", "user.name", "t"]).unwrap();
        git_ok(Path::new(&wt.path), &["config", "user.email", "t@t"]).unwrap();
        std::fs::write(Path::new(&wt.path).join("c.txt"), "3\n").unwrap();
        commit(&wt.path, "worker: add c").unwrap();
        assert_eq!(
            status(&wt.path, "main").unwrap(),
            WorktreeStatus {
                dirty_files: 0,
                ahead: 1,
                behind: 0
            }
        );
        assert!(commit(&wt.path, "nothing new").is_err());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn conflicting_merge_is_aborted() {
        let root = repo();
        let r = root.to_string_lossy().to_string();
        let wt = create(&r, "clash", "main").unwrap();
        std::fs::write(Path::new(&wt.path).join("a.txt"), "theirs\n").unwrap();
        commit_all(Path::new(&wt.path), "theirs");
        std::fs::write(root.join("a.txt"), "ours\n").unwrap();
        commit_all(&root, "ours");
        assert!(merge(&r, &wt.branch, "main").is_err());
        // The merge was aborted: no MERGE_HEAD left, main still has its own content.
        assert!(!root.join(".git").join("MERGE_HEAD").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "ours\n"
        );
        std::fs::remove_dir_all(&root).ok();
    }
}
