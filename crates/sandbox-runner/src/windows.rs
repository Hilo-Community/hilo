//! The Windows engine: an AppContainer for isolation, a Job Object for supervision.
//!
//! All the `unsafe` lives in the `sandbox-windows` crate; this module only describes the launch
//! and proves, at start-up, that the isolation works on this machine.
//!
//! * **Files:** the AppContainer has no access to the user's files. The worktree is the only
//!   directory it is granted, for the run only: an entry is added to its ACL (inherited by its
//!   content, so the cost grows with the number of files) and removed afterwards. System
//!   directories are readable by every AppContainer, so the OS and the programs installed there
//!   run; a toolchain installed under the user's profile is not readable and fails to start.
//! * **Links:** a worktree containing a junction, a symbolic link or a hard link is refused
//!   before any permission changes, since the access granted would follow the link outside.
//! * **Crash safety:** each run is recorded in a journal (`%LOCALAPPDATA%\Hilo\sandbox-runs`)
//!   until it has undone its changes; the self-test first undoes the runs of a Host that died.
//! * **Read-only worktrees and shares:** read/execute ACLs grant access to the unique run SID;
//!   shares are split around forbidden content so it receives no inherited grants. All changed
//!   paths are journaled before mutation and the
//!   SID's entries are revoked on cleanup or crash recovery. Host permissions are preserved.
//! * **Network:** no capability is granted, so there is no network at all, loopback included.
//!   `NetworkPolicy::LocalProxyOnly` is therefore refused (as on Linux): LOT-014 hands the
//!   agent another channel.
//! * **Limits:** memory, process count and CPU time come from the Job Object and are enforced.
//! * **Programs started by `cmd`:** found through the `PATH` of the request, as build tools do.
//!   `cmd` refuses a program named by its absolute path ("Access is denied"): it walks every
//!   folder of that path from the drive root, which an AppContainer cannot list. Programs the
//!   runner starts itself, or that other programs start, are not affected.

use std::ffi::OsString;
use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::time::Duration;

use path_util::plain_path as plain;
use sandbox_windows::{JobLimits, LaunchConfig};

use crate::engine::{EngineCapabilities, Launch, OsSandboxEngine};
use crate::error::SandboxError;
use crate::spec::{ResourceLimits, ValidatedSpec};
use crate::supervisor::{new_run_id, run_to_completion, RunOutput, SandboxedChild, TmpDir};
use crate::OsSandboxKind;

/// Variables that point programs at a temporary directory.
const TMP_VARS: [&str; 3] = ["TMPDIR", "TMP", "TEMP"];

/// Variables Windows itself needs to start a process in an AppContainer with an environment of
/// our own: without them `CreateProcessW` fails with `ERROR_ENVVAR_NOT_FOUND` (203). They are
/// locations of the system and of the profile, copied from the Host; none holds a secret, and
/// the AppContainer cannot read the profile directories they name anyway.
const SYSTEM_VARS: [&str; 10] = [
    "SystemRoot",
    "windir",
    "SystemDrive",
    "ComSpec",
    "PATHEXT",
    "ProgramData",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PUBLIC",
];

fn same_name(left: &OsString, right: &str) -> bool {
    left.eq_ignore_ascii_case(right)
}

fn environment_for<'a>(
    caller: impl IntoIterator<Item = (&'a OsString, &'a OsString)>,
    tmp: &Path,
    include_host_profile_vars: bool,
) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = Vec::new();
    let mut set = |key: OsString, value: OsString| {
        env.retain(|(existing, _)| !existing.eq_ignore_ascii_case(&key));
        env.push((key, value));
    };
    for var in SYSTEM_VARS {
        if !include_host_profile_vars && matches!(var, "USERPROFILE" | "APPDATA" | "LOCALAPPDATA") {
            // CreateProcessW still needs these entries for an AppContainer. Point them at
            // this run's writable scratch space instead of omitting them (error 203) or
            // exposing the Host's profile locations.
            set(var.into(), tmp.as_os_str().to_os_string());
            continue;
        }
        if let Some(value) = std::env::var_os(var) {
            set(var.into(), value);
        }
    }
    for (key, value) in caller {
        if !TMP_VARS.iter().any(|var| same_name(key, var)) {
            set(key.clone(), value.clone());
        }
    }
    for var in TMP_VARS {
        set(var.into(), tmp.as_os_str().to_os_string());
    }
    env
}

/// The environment of a sandboxed process: the system variables, then the caller's (which win,
/// whatever their case), then the private temporary directory (which wins over both). Names are
/// case-insensitive on Windows and a duplicate would be refused.
fn environment<'a>(
    caller: impl IntoIterator<Item = (&'a OsString, &'a OsString)>,
    tmp: &Path,
) -> Vec<(OsString, OsString)> {
    environment_for(caller, tmp, true)
}

/// Denies everything under `directory` except the `keep` paths. The folders leading to a kept
/// path are walked, not exempted, so their other content stays unreadable.
fn deny_all_but(
    directory: &Path,
    keep: &[PathBuf],
    denied: &mut Vec<PathBuf>,
) -> std::io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let path = plain(entry?.path());
        if keep.contains(&path) {
            continue;
        }
        if keep.iter().any(|kept| kept.starts_with(&path)) {
            deny_all_but(&path, keep, denied)?;
        } else {
            denied.push(path);
        }
    }
    Ok(())
}

/// The Windows engine: each run gets its own AppContainer profile and Job Object, recorded in a
/// journal until it has cleaned up after itself.
#[derive(Debug, Clone)]
pub struct AppContainerEngine {
    journal_dir: PathBuf,
}

impl AppContainerEngine {
    /// Keeps its journal in `%LOCALAPPDATA%\Hilo\sandbox-runs`.
    pub fn for_current_user() -> Result<Self, SandboxError> {
        let local = std::env::var_os("LOCALAPPDATA")
            .ok_or_else(|| SandboxError::unavailable("the LOCALAPPDATA variable is not set"))?;
        Ok(Self::with_journal_dir(
            Path::new(&local).join("Hilo").join("sandbox-runs"),
        ))
    }

    /// Keeps its journal in `journal_dir` (an absolute directory of the Host, outside every
    /// worktree).
    #[must_use]
    pub fn with_journal_dir(journal_dir: impl Into<PathBuf>) -> Self {
        Self {
            journal_dir: journal_dir.into(),
        }
    }

    fn launch_config(&self, spec: &ValidatedSpec) -> Result<LaunchConfig, SandboxError> {
        if !spec.worktree_read_only && !spec.read_only_paths.is_empty() {
            return Err(SandboxError::InvalidSpec(
                "the Windows sandbox only supports read-only shares with a read-only worktree"
                    .into(),
            ));
        }
        let root = plain(&spec.worktree_root);
        let mut denied_read_paths: Vec<_> = spec.denied_read_paths.iter().map(plain).collect();
        if spec.mediate_worktree_reads {
            let keep = [plain(&spec.program), plain(&spec.tmp_dir)];
            deny_all_but(&spec.worktree_root, &keep, &mut denied_read_paths)?;
        }
        let writable_dirs = std::iter::once(if spec.worktree_read_only {
            plain(&spec.tmp_dir)
        } else {
            root.clone()
        })
        .chain(spec.writable_paths.iter().map(plain))
        .collect();
        let mut read_only_dirs: Vec<_> = spec.read_only_paths.iter().map(plain).collect();
        if spec.worktree_read_only {
            read_only_dirs.insert(0, root);
        }
        Ok(LaunchConfig {
            program: plain(&spec.program),
            args: spec.args.clone(),
            cwd: plain(&spec.cwd),
            env: environment_for(&spec.env, &plain(&spec.tmp_dir), !spec.worktree_read_only),
            writable_dirs,
            read_only_dirs,
            denied_read_paths,
            journal_dir: self.journal_dir.clone(),
            limits: JobLimits {
                max_processes: spec.limits.max_processes,
                max_memory_bytes: spec.limits.max_memory_bytes,
                max_cpu_time: spec.limits.max_cpu_time,
            },
            container_name: format!("hilo-{}", spec.run_id),
            stdin_piped: false,
        })
    }
}

impl OsSandboxEngine for AppContainerEngine {
    fn capabilities(&self) -> EngineCapabilities {
        EngineCapabilities {
            name: "appcontainer",
            kind: OsSandboxKind::WindowsAppContainerJobObject,
            enforces_memory_limit: true,
            enforces_process_limit: true,
            enforces_cpu_limit: true,
            supports_local_proxy: false,
        }
    }

    /// First undoes the runs of a Host that died before cleaning up (see
    /// `sandbox_windows::recover_stale_runs`), then proves the isolation.
    fn self_test(&self) -> Result<(), SandboxError> {
        sandbox_windows::recover_stale_runs(&self.journal_dir).map_err(|error| {
            SandboxError::unavailable(format!(
                "could not clean up after an earlier sandbox run ({}): {error}",
                self.journal_dir.display()
            ))
        })?;
        self_test(&self.journal_dir)
    }

    fn prepare(&self, spec: &ValidatedSpec) -> Result<Launch, SandboxError> {
        Ok(Launch::AppContainer(Box::new(self.launch_config(spec)?)))
    }
}

/// Removes the self-test's files when dropped.
struct ProbeDir(PathBuf);

impl Drop for ProbeDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn probe_failure(what: &str, detail: impl std::fmt::Display) -> SandboxError {
    SandboxError::unavailable(format!("AppContainer self-test: {what} ({detail})"))
}

/// The self-test's throw-away layout: `work` is the probe's worktree, `outside` a sibling it
/// must not reach.
struct Probe {
    _cleanup: ProbeDir,
    journal_dir: PathBuf,
    system32: PathBuf,
    work: PathBuf,
    outside: PathBuf,
}

impl Probe {
    fn new(journal_dir: &Path) -> Result<Self, SandboxError> {
        let system_root = std::env::var_os("SystemRoot")
            .ok_or_else(|| SandboxError::unavailable("the SystemRoot variable is not set"))?;
        let base = std::env::temp_dir().join(format!("hilo-selftest-{}", new_run_id()));
        let cleanup = ProbeDir(base.clone());
        let (work, outside) = (base.join("work"), base.join("outside"));
        fs::create_dir_all(&work)?;
        fs::create_dir_all(&outside)?;
        fs::write(outside.join(SECRET_FILE), SECRET)?;
        fs::write(work.join("input.txt"), "readable")?;
        Ok(Self {
            _cleanup: cleanup,
            journal_dir: journal_dir.to_path_buf(),
            system32: Path::new(&system_root).join("System32"),
            work,
            outside,
        })
    }

    /// Runs a program of `System32` in a fresh AppContainer, under the regular supervision.
    fn run(&self, program: &str, args: &[&str]) -> Result<RunOutput, SandboxError> {
        let tmp = TmpDir::create(&self.work)?;
        let config = LaunchConfig {
            program: self.system32.join(program),
            args: args.iter().map(OsString::from).collect(),
            cwd: self.work.clone(),
            env: environment([], tmp.path()),
            writable_dirs: vec![self.work.clone()],
            read_only_dirs: Vec::new(),
            denied_read_paths: Vec::new(),
            journal_dir: self.journal_dir.clone(),
            limits: JobLimits::default(),
            container_name: format!("hilo-selftest-{}", new_run_id()),
            stdin_piped: false,
        };
        let mut child = SandboxedChild::spawn_prepared(
            Launch::AppContainer(Box::new(config)),
            tmp,
            None,
            false,
            None,
        )
        .map_err(|error| probe_failure(&format!("{program} could not start"), error))?;
        run_to_completion(&mut child, &PROBE_LIMITS)
    }
}

const SECRET_FILE: &str = "secret.txt";
const SECRET: &str = "HILO-SELF-TEST-SECRET";

const PROBE_LIMITS: ResourceLimits = ResourceLimits {
    wall_timeout: Duration::from_secs(30),
    max_output_bytes: 64 * 1024,
    max_processes: None,
    max_memory_bytes: None,
    max_cpu_time: None,
};

fn stdout(output: &RunOutput) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// Proves on this machine that the AppContainer isolates. Positive controls first (the probe
/// programs run and can use their worktree), so that nothing passes merely because nothing runs;
/// then the negative controls, which are the isolation itself.
fn self_test(journal_dir: &Path) -> Result<(), SandboxError> {
    let probe = Probe::new(journal_dir)?;

    // Positive controls.
    let made = probe.run("cmd.exe", &["/d", "/c", "echo ok>probe.txt"])?;
    let written = fs::read_to_string(probe.work.join("probe.txt")).unwrap_or_default();
    if !made.termination.success() || written.trim() != "ok" {
        return Err(probe_failure(
            "a process cannot write its worktree",
            format!("{:?}", made.termination),
        ));
    }
    let read = probe.run("findstr.exe", &["readable", "input.txt"])?;
    if !read.termination.success() || !stdout(&read).contains("readable") {
        return Err(probe_failure(
            "a process cannot read its worktree",
            format!("{:?}", read.termination),
        ));
    }
    let curl = probe.run("curl.exe", &["--version"])?;
    if !curl.termination.success() {
        return Err(probe_failure(
            "the network probe tool does not run in the sandbox",
            format!("{:?}", curl.termination),
        ));
    }

    // Negative controls: files. Paths are relative so that `cmd` needs no quoting.
    let leaked = probe.run("cmd.exe", &["/d", "/c", r"type ..\outside\secret.txt"])?;
    if stdout(&leaked).contains(SECRET) {
        return Err(probe_failure(
            "a process can read outside its worktree",
            SECRET_FILE,
        ));
    }
    probe.run("cmd.exe", &["/d", "/c", r"echo x>..\outside\escape.txt"])?;
    if probe.outside.join("escape.txt").exists() {
        return Err(probe_failure(
            "a process can write outside its worktree",
            "escape.txt",
        ));
    }

    // Negative control: network, loopback included.
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.set_nonblocking(true).map(|()| listener))
        .map_err(|error| probe_failure("could not open a probe listener", error))?;
    let port = listener
        .local_addr()
        .map_err(|error| probe_failure("could not read the probe listener address", error))?
        .port();
    let url = format!("http://127.0.0.1:{port}/");
    probe.run("curl.exe", &["--silent", "--max-time", "5", &url])?;
    if listener.accept().is_ok() {
        return Err(probe_failure(
            "a process can open a network connection",
            url,
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{environment, plain};
    use std::ffi::OsString;
    use std::path::Path;

    #[test]
    fn mediated_reads_keep_nested_program_and_scratch_ancestors_accessible() {
        use super::{AppContainerEngine, Launch, OsSandboxEngine};
        use crate::SandboxSpec;
        let work = tempfile::tempdir().unwrap();
        let root = work.path().canonicalize().unwrap();
        let bin = root.join("node_modules").join(".bin");
        std::fs::create_dir_all(&bin).unwrap();
        let program = bin.join("agent-cli.exe");
        std::fs::write(&program, "test executable").unwrap();
        let source = root.join("source.txt");
        std::fs::write(&source, "private").unwrap();
        let scratch = root.join("scratch").join("run");
        std::fs::create_dir_all(&scratch).unwrap();
        // Neighbours of the folders leading to the program and to the scratch directory.
        let neighbours = [
            bin.join("other-cli.exe"),
            root.join("node_modules").join("package.js"),
            root.join("scratch").join("old-run.log"),
        ];
        for neighbour in &neighbours {
            std::fs::write(neighbour, "private").unwrap();
        }
        let mut spec = SandboxSpec::new(&root, &program);
        spec.worktree_read_only = true;
        spec.mediate_worktree_reads = true;
        spec.denied_read_paths.push(source.clone());
        let mut validated = spec.validate().unwrap();
        validated.tmp_dir = scratch;
        let engine = AppContainerEngine::with_journal_dir(root.join("journal"));
        let Launch::AppContainer(config) = engine.prepare(&validated).unwrap() else {
            panic!("AppContainer required")
        };
        assert!(config.denied_read_paths.contains(&plain(&source)));
        for neighbour in &neighbours {
            assert!(
                config.denied_read_paths.contains(&plain(neighbour)),
                "{} stays readable",
                neighbour.display()
            );
        }
        assert!(config
            .denied_read_paths
            .iter()
            .all(|path| !plain(&program).starts_with(path)));
        assert!(config
            .denied_read_paths
            .iter()
            .all(|path| !plain(&validated.tmp_dir).starts_with(path)));
    }

    #[test]
    fn the_environment_has_the_system_variables_the_callers_and_one_private_temp() {
        let caller = [
            (OsString::from("temp"), OsString::from(r"C:\elsewhere")),
            (OsString::from("systemroot"), OsString::from(r"D:\Windows")),
            (OsString::from("MY_VAR"), OsString::from("1")),
        ];
        let env = environment(caller.iter().map(|(k, v)| (k, v)), Path::new(r"C:\w\tmp"));
        let get = |name: &str| {
            let found: Vec<_> = env
                .iter()
                .filter(|(key, _)| key.eq_ignore_ascii_case(name))
                .collect();
            assert!(found.len() <= 1, "{name} appears twice");
            found
                .first()
                .map(|(_, value)| value.to_string_lossy().into_owned())
        };
        assert_eq!(get("TEMP").as_deref(), Some(r"C:\w\tmp"));
        assert_eq!(get("TMP").as_deref(), Some(r"C:\w\tmp"));
        assert_eq!(get("SystemRoot").as_deref(), Some(r"D:\Windows"));
        assert_eq!(get("MY_VAR").as_deref(), Some("1"));
        assert!(get("ComSpec").is_some(), "the system variables are missing");
    }

    #[test]
    fn verbatim_drive_paths_become_plain_and_others_are_kept() {
        assert_eq!(plain(Path::new(r"\\?\C:\work")), Path::new(r"C:\work"));
        assert_eq!(
            plain(Path::new(r"\\?\UNC\server\share")),
            Path::new(r"\\?\UNC\server\share")
        );
        assert_eq!(plain(Path::new(r"C:\work")), Path::new(r"C:\work"));
    }
    #[test]
    fn read_only_and_denied_paths_are_in_the_appcontainer_launch_plan() {
        use super::{AppContainerEngine, Launch, OsSandboxEngine};
        use crate::SandboxSpec;
        let work = tempfile::tempdir().unwrap();
        let root = work.path().canonicalize().unwrap();
        let file = root.join("source.txt");
        std::fs::write(&file, "unchanged").unwrap();
        let scratch = root.join("scratch");
        std::fs::create_dir(&scratch).unwrap();
        let engine = AppContainerEngine::with_journal_dir(root.join("journal"));
        let mut spec = SandboxSpec::new(&root, std::env::current_exe().unwrap());
        spec.worktree_read_only = true;
        spec.denied_read_paths.push(file.clone());
        let mut validated = spec.validate().unwrap();
        validated.tmp_dir = scratch.clone();
        let Launch::AppContainer(config) = engine.prepare(&validated).unwrap() else {
            panic!("AppContainer required")
        };
        assert_eq!(config.writable_dirs, vec![super::plain(&scratch)]);
        for name in ["USERPROFILE", "APPDATA", "LOCALAPPDATA"] {
            let value = config
                .env
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.as_os_str());
            assert_eq!(value, Some(super::plain(&scratch).as_os_str()));
        }
        assert_eq!(
            config.read_only_dirs,
            vec![super::plain(work.path().canonicalize().unwrap())]
        );
        assert_eq!(
            config.denied_read_paths,
            vec![super::plain(file.canonicalize().unwrap())]
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "unchanged");
        assert!(!work.path().join("journal").exists());
    }
}
