use std::env;
use std::io::{self, IsTerminal};
use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use clap::{Parser, ValueEnum};

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum Appearance {
    Dark,
    Light,
}

#[derive(Debug, Clone, Parser)]
#[command(
    name = "router-tui",
    version,
    about = "Terminal control dashboard for the local AI router",
    after_help = "真实后端需要 Node.js 与 router.mjs；--demo 不需要任何凭证。"
)]
pub struct Cli {
    /// Path to the router repository (defaults to current/parent directory)
    #[arg(long, value_name = "PATH")]
    pub router_root: Option<PathBuf>,

    /// Node.js executable
    #[arg(long, value_name = "PROGRAM")]
    pub node: Option<String>,

    /// Use anonymous in-memory data; never starts Node
    #[arg(long)]
    pub demo: bool,

    /// Disable all state-changing actions
    #[arg(long)]
    pub read_only: bool,

    /// Use ASCII status markers
    #[arg(long)]
    pub ascii: bool,

    /// Disable colors
    #[arg(long)]
    pub no_color: bool,

    /// Terminal appearance
    #[arg(long, value_enum, default_value_t = Appearance::Dark)]
    pub appearance: Appearance,

    /// Provider status refresh interval in seconds
    #[arg(long, default_value_t = 5, value_name = "SECONDS")]
    pub refresh_secs: u64,
}

#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    pub router_root: Option<PathBuf>,
    pub node: String,
    pub demo: bool,
    pub read_only: bool,
    pub ascii: bool,
    pub no_color: bool,
    pub appearance: Appearance,
    pub refresh_secs: u64,
}

impl RuntimeConfig {
    pub fn from_cli(cli: Cli) -> Result<Self> {
        if cli.refresh_secs == 0 {
            bail!("--refresh-secs 必须大于 0");
        }
        if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
            bail!("router-tui 需要交互式 TTY；请在真实终端中运行，或先使用 --help");
        }

        let node = cli
            .node
            .or_else(|| env::var("ROUTER_NODE").ok())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "node".to_string());

        let router_root = if cli.demo {
            cli.router_root
        } else {
            Some(discover_root(cli.router_root)?)
        };

        let no_color =
            cli.no_color || env::var_os("NO_COLOR").is_some_and(|value| !value.is_empty());

        Ok(Self {
            router_root,
            node,
            demo: cli.demo,
            read_only: cli.read_only,
            ascii: cli.ascii,
            no_color,
            appearance: cli.appearance,
            refresh_secs: cli.refresh_secs,
        })
    }
}

fn discover_root(explicit: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(path) = explicit {
        return validate_root(path);
    }
    if let Some(value) = env::var_os("ROUTER_ROOT") {
        return validate_root(PathBuf::from(value));
    }

    let cwd = env::current_dir().context("无法读取当前目录")?;
    for candidate in [cwd.clone(), cwd.join("..")] {
        if candidate.join("router.mjs").is_file() {
            return candidate
                .canonicalize()
                .with_context(|| format!("无法规范化 {}", candidate.display()));
        }
    }

    bail!("找不到 router.mjs。请从 router 仓库内运行，或传入 --router-root <PATH> / ROUTER_ROOT")
}

fn validate_root(path: PathBuf) -> Result<PathBuf> {
    let root = path
        .canonicalize()
        .with_context(|| format!("router root 不存在：{}", path.display()))?;
    if !root.join("router.mjs").is_file() {
        bail!("{} 中没有 router.mjs", root.display());
    }
    if !root.join("scripts").join("health.mjs").is_file() {
        bail!("{} 中缺少 scripts/health.mjs", root.display());
    }
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_root_must_contain_router_scripts() {
        let error = discover_root(Some(PathBuf::from("definitely-missing-router-root")))
            .expect_err("missing root should fail");
        assert!(error.to_string().contains("不存在"));
    }

    #[test]
    fn zero_refresh_is_rejected_before_terminal_setup() {
        let cli = Cli {
            router_root: None,
            node: None,
            demo: true,
            read_only: false,
            ascii: false,
            no_color: true,
            appearance: Appearance::Dark,
            refresh_secs: 0,
        };
        let error = RuntimeConfig::from_cli(cli).expect_err("zero refresh must fail");
        assert!(error.to_string().contains("refresh-secs"));
    }
}
