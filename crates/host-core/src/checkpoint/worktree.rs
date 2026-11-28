//! Copy-on-Write task worktrees (`LOT-011`, `CowWorktreeProvisioner`).
//!
//! A task's worktree is the content of its latest checkpoint, materialized in
//! `<worktrees dir>/<repository id>/<task_id>`: the agent sees exactly what the user saw,
//! unsaved buffers included. A file whose disk content is still the checkpointed one is
//! cloned (`clonefile` on APFS, `FICLONE` on btrfs/XFS, block cloning on ReFS), which shares
//! its blocks until one side writes; the others (unsaved buffers, files changed since) are
//! written from the checkpoint's blobs.
//!
//! **Fail closed:** when the file system cannot clone (ext4, NTFS, HFS+, a Git directory on
//! another volume), provisioning fails with [`CheckpointError::CowUnavailable`] and removes
//! what it created. It never falls back to a full copy.
//!
//! **Location:** the Host gives the worktrees directory (an application cache directory)
//! with [`CheckpointManager::with_worktrees_dir`]. It must be outside the repository and have
//! no `.git` component: tools refuse to serve or watch files below `.git/` (Vite's
//! `server.fs.deny` includes `**/.git/**`, which broke Vitest in a worktree kept there). It
//! must be on the same volume as the workspace for Copy-on-Write to work.
//!
//! **Budget `< 5 ms`: not met, kept as an objective.** Measured on macOS/APFS (release build):
//! median 15.6 ms for 1,000 files, of which a single `clonefile` of the directory alone takes
//! 7–9 ms and checking that the files are unchanged ~3.5 ms. The test
//! `provisioning_a_task_worktree_of_a_thousand_files_takes_under_5_ms` enforces the budget in
//! optimized builds only, and fails there.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use git2::{Index, IndexEntry, ObjectType, Oid, Repository, Tree};
use serde::{Deserialize, Serialize};

use super::packages::{share_package_stores, SharedPackageStore, StoreScope};
use super::paths::{from_git_path, write_new_file};
use super::snapshot::{stat_matches, MODE_EXECUTABLE, MODE_FILE, MODE_SYMLINK};
use super::{load_history, validate_task_id, CheckpointError, CheckpointManager};

/// A provisioned task worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskWorktree {
    pub task_id: String,
    /// Root of the worktree (the repository's layout).
    pub path: PathBuf,
    /// Where the workspace is inside it (differs from `path` when the workspace is a
    /// subdirectory of the repository).
    pub workspace: PathBuf,
    /// The checkpoint it was materialized from.
    pub checkpoint_seq: u32,
    /// Files shared with the workspace by Copy-on-Write.
    pub cloned_files: usize,
    /// Files written from the checkpoint (unsaved buffers, files changed since).
    pub written_files: usize,
    /// The user's installed packages made available in the worktree; the sandbox must expose
    /// each `source` read-only (see `packages.rs`).
    pub shared_package_stores: Vec<SharedPackageStore>,
    pub elapsed: Duration,
}

impl CheckpointManager {
    /// Materializes the latest checkpoint of `task_id` into a fresh worktree.
    pub fn provision_worktree(&self, task_id: &str) -> Result<TaskWorktree, CheckpointError> {
        self.provision_worktree_with_mode(task_id, task_id, true)
    }

    /// Materializes the latest checkpoint of `task_id` into a fresh worktree by Copy-on-Write when
    /// the volume supports it, or by writing the checkpointed blobs when Copy-on-Write is
    /// unavailable (e.g. NTFS, ext4, or when the worktrees directory is on another volume).
    pub fn provision_worktree_or_copy(
        &self,
        task_id: &str,
    ) -> Result<TaskWorktree, CheckpointError> {
        self.provision_worktree_slot(task_id, task_id)
    }

    /// Materializes a fresh task checkpoint at a stable location held exclusively by the caller.
    pub fn provision_worktree_slot(
        &self,
        task_id: &str,
        slot: &str,
    ) -> Result<TaskWorktree, CheckpointError> {
        match self.provision_worktree_with_mode(task_id, slot, true) {
            Err(CheckpointError::CowUnavailable { .. }) => {
                self.provision_worktree_with_mode(task_id, slot, false)
            }
            other => other,
        }
    }

    fn provision_worktree_with_mode(
        &self,
        task_id: &str,
        slot: &str,
        allow_cow: bool,
    ) -> Result<TaskWorktree, CheckpointError> {
        validate_task_id(task_id)?;
        validate_task_id(slot)?;
        let started = Instant::now();
        let repo = self.lock();
        let latest =
            load_history(&repo, task_id)?
                .pop()
                .ok_or_else(|| CheckpointError::NoCheckpoint {
                    task_id: task_id.to_string(),
                })?;
        let path = self.worktree_path(slot)?;
        fs::create_dir_all(path.parent().unwrap_or(&path))
            .map_err(|source| io_error(&path, source))?;
        // `create_dir`, not `create_dir_all`: an existing worktree is an error, never reused.
        fs::create_dir(&path).map_err(|source| match source.kind() {
            io::ErrorKind::AlreadyExists => CheckpointError::WorktreeExists {
                task_id: task_id.to_string(),
            },
            _ => io_error(&path, source),
        })?;

        let mut counts = (0, 0);
        let result = self
            .materialize(&repo, latest.tree, &path, allow_cow, &mut counts)
            .and_then(|()| {
                if cfg!(windows) && !allow_cow {
                    // Package sharing uses links, which the Windows AppContainer refuses.
                    // Report the limitation rather than silently returning an empty store list.
                    tracing::warn!(
                        task_id,
                        worktree = %path.display(),
                        "Windows checkpoint copy omits installed package stores; tools requiring the workspace's node_modules may be unavailable in this task"
                    );
                    return Ok(Vec::new());
                }
                let scope = StoreScope {
                    repo: &repo,
                    workdir: &self.workdir,
                    prefix: &self.prefix,
                    root: &path,
                };
                share_package_stores(&scope, latest.tree)
            });
        let shared_package_stores = match result {
            Ok(shared) => shared,
            Err(error) => {
                let _ = fs::remove_dir_all(&path);
                return Err(error);
            }
        };
        Ok(TaskWorktree {
            task_id: task_id.to_string(),
            workspace: path.join(&self.prefix),
            path,
            checkpoint_seq: latest.seq,
            cloned_files: counts.0,
            written_files: counts.1,
            shared_package_stores,
            elapsed: started.elapsed(),
        })
    }

    /// Deletes the worktree of `task_id`. Returns whether there was one.
    pub fn release_worktree(&self, task_id: &str) -> Result<bool, CheckpointError> {
        validate_task_id(task_id)?;
        let _repo = self.lock();
        remove_worktree(&self.worktree_path(task_id)?)
    }

    pub(super) fn worktree_path(&self, task_id: &str) -> Result<PathBuf, CheckpointError> {
        let dir = self
            .worktrees_dir
            .as_ref()
            .ok_or(CheckpointError::WorktreesDirNotConfigured)?;
        Ok(dir.join(&self.repository_id).join(task_id))
    }

    fn materialize(
        &self,
        repo: &Repository,
        tree: git2::Oid,
        root: &Path,
        allow_cow: bool,
        counts: &mut (usize, usize),
    ) -> Result<(), CheckpointError> {
        // Blob ids the last snapshot read from disk, with the stat they had (read-only here).
        let cache: HashMap<Vec<u8>, IndexEntry> = if allow_cow {
            match Index::open(&self.cache_path) {
                Ok(index) => index
                    .iter()
                    .map(|entry| (entry.path.clone(), entry))
                    .collect(),
                Err(_) => HashMap::new(),
            }
        } else {
            HashMap::new()
        };
        let walk = Materialize {
            repo,
            workdir: &self.workdir,
            root,
            cache: &cache,
            allow_cow,
        };
        walk.tree(&repo.find_tree(tree)?, &[], counts)
    }
}

struct Materialize<'a> {
    repo: &'a Repository,
    workdir: &'a Path,
    root: &'a Path,
    cache: &'a HashMap<Vec<u8>, IndexEntry>,
    allow_cow: bool,
}

impl Materialize<'_> {
    fn tree(
        &self,
        tree: &Tree<'_>,
        prefix: &[u8],
        counts: &mut (usize, usize),
    ) -> Result<(), CheckpointError> {
        for entry in tree.iter() {
            let git_path = join(prefix, entry.name_bytes());
            let relative = from_git_path(&git_path)?;
            let target = self.root.join(&relative);
            let source = self.workdir.join(&relative);
            let mode = entry.filemode() as u32;
            if entry.kind() == Some(ObjectType::Tree) {
                let subtree = self.repo.find_tree(entry.id())?;
                // One clone for a whole directory that is still exactly the checkpoint (macOS
                // clones hierarchies; elsewhere files are cloned one by one).
                if self.allow_cow && cfg!(target_os = "macos") {
                    if let Some(files) = self.clean_dir(&subtree, &git_path, &source)? {
                        clone(&source, &target)?;
                        counts.0 += files;
                        continue;
                    }
                }
                fs::create_dir(&target).map_err(|source| io_error(&target, source))?;
                self.tree(&subtree, &git_path, counts)?;
                continue;
            }
            if !matches!(mode, MODE_FILE | MODE_EXECUTABLE | MODE_SYMLINK) {
                continue; // Submodules are never part of a checkpoint.
            }
            if self.allow_cow
                && mode != MODE_SYMLINK
                && self.unchanged_file(&git_path, entry.id(), mode, &source)
            {
                clone(&source, &target)?;
                counts.0 += 1;
                continue;
            }
            let blob = self.repo.find_blob(entry.id())?;
            if mode == MODE_SYMLINK {
                write_symlink(&target, blob.content())?;
            } else {
                write_new_file(&target, blob.content(), mode == MODE_EXECUTABLE)?;
            }
            counts.1 += 1;
        }
        Ok(())
    }

    /// The workspace file is the one the checkpoint read, unchanged since.
    fn unchanged_file(&self, git_path: &[u8], id: Oid, mode: u32, source: &Path) -> bool {
        self.cache.get(git_path).is_some_and(|cached| {
            cached.id == id
                && cached.mode == mode
                && fs::symlink_metadata(source)
                    .is_ok_and(|meta| meta.is_file() && stat_matches(&meta, cached))
        })
    }

    /// `Some(file count)` when the workspace directory holds exactly the checkpointed entries,
    /// all unchanged: no ignored or skipped file, no symbolic link, nothing added.
    fn clean_dir(
        &self,
        tree: &Tree<'_>,
        prefix: &[u8],
        source: &Path,
    ) -> Result<Option<usize>, CheckpointError> {
        let Ok(entries) = fs::read_dir(source) else {
            return Ok(None);
        };
        if entries.count() != tree.len() {
            return Ok(None);
        }
        let mut files = 0;
        for entry in tree.iter() {
            let git_path = join(prefix, entry.name_bytes());
            let path = self.workdir.join(from_git_path(&git_path)?);
            let mode = entry.filemode() as u32;
            if entry.kind() == Some(ObjectType::Tree) {
                let is_dir = fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_dir());
                match is_dir
                    .then(|| self.clean_dir(&self.repo.find_tree(entry.id())?, &git_path, &path))
                {
                    Some(Ok(Some(count))) => files += count,
                    Some(Err(error)) => return Err(error),
                    _ => return Ok(None),
                }
            } else if matches!(mode, MODE_FILE | MODE_EXECUTABLE)
                && self.unchanged_file(&git_path, entry.id(), mode, &path)
            {
                files += 1;
            } else {
                return Ok(None);
            }
        }
        Ok(Some(files))
    }
}

fn join(prefix: &[u8], name: &[u8]) -> Vec<u8> {
    let mut path = prefix.to_vec();
    if !path.is_empty() {
        path.push(b'/');
    }
    path.extend_from_slice(name);
    path
}

/// Copy-on-Write clone; any failure is fatal (no fallback to a copy).
fn clone(source: &Path, target: &Path) -> Result<(), CheckpointError> {
    reflink_copy::reflink(source, target).map_err(|error| CheckpointError::CowUnavailable {
        path: source.to_path_buf(),
        source: error,
    })
}

pub(super) fn remove_worktree(path: &Path) -> Result<bool, CheckpointError> {
    match fs::symlink_metadata(path) {
        // A link planted in place of the worktree is removed, never followed.
        Ok(meta) if meta.file_type().is_symlink() || meta.is_file() => {
            fs::remove_file(path).map_err(|source| io_error(path, source))?;
            Ok(true)
        }
        Ok(_) => {
            fs::remove_dir_all(path).map_err(|source| io_error(path, source))?;
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(source) => Err(io_error(path, source)),
    }
}

#[cfg(unix)]
fn write_symlink(target: &Path, destination: &[u8]) -> Result<(), CheckpointError> {
    super::paths::write_symlink(target, destination)
}

#[cfg(not(unix))]
fn write_symlink(target: &Path, _destination: &[u8]) -> Result<(), CheckpointError> {
    Err(io_error(
        target,
        io::Error::other("symbolic links are not materialized on this platform"),
    ))
}

fn io_error(path: &Path, source: io::Error) -> CheckpointError {
    CheckpointError::Io {
        path: path.to_path_buf(),
        source,
    }
}
