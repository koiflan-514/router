pub mod fixture;
pub mod node;

use std::fmt;

use crate::domain::{
    AccountSnapshot, Action, CreditsSnapshot, ProviderSnapshot, TextResult, UsageRange,
    UsageSnapshot,
};

use fixture::FixtureBackend;
use node::NodeBackend;

#[derive(Debug, Clone)]
pub struct BackendError {
    pub message: String,
}

impl BackendError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for BackendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for BackendError {}

pub type BackendResult<T> = Result<T, BackendError>;

#[derive(Debug, Clone, Default)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub truncated: bool,
}

#[derive(Debug, Clone)]
pub enum Backend {
    Node(NodeBackend),
    Fixture(FixtureBackend),
}

impl Backend {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Node(_) => "LIVE",
            Self::Fixture(_) => "DEMO",
        }
    }

    pub fn is_demo(&self) -> bool {
        matches!(self, Self::Fixture(_))
    }

    pub fn is_read_only(&self) -> bool {
        match self {
            Self::Node(backend) => backend.is_read_only(),
            Self::Fixture(backend) => backend.is_read_only(),
        }
    }

    pub fn root_label(&self) -> String {
        match self {
            Self::Node(backend) => backend.root_label(),
            Self::Fixture(_) => "匿名演示数据".to_string(),
        }
    }

    pub fn node_label(&self) -> String {
        match self {
            Self::Node(backend) => backend.node_label(),
            Self::Fixture(_) => "demo".to_string(),
        }
    }

    pub async fn providers(&self) -> BackendResult<ProviderSnapshot> {
        match self {
            Self::Node(backend) => backend.providers().await,
            Self::Fixture(backend) => backend.providers().await,
        }
    }

    pub async fn accounts(&self) -> BackendResult<AccountSnapshot> {
        match self {
            Self::Node(backend) => backend.accounts().await,
            Self::Fixture(backend) => backend.accounts().await,
        }
    }

    pub async fn credits(&self) -> BackendResult<CreditsSnapshot> {
        match self {
            Self::Node(backend) => backend.credits().await,
            Self::Fixture(backend) => backend.credits().await,
        }
    }

    pub async fn logs(&self, provider_id: &str, lines: usize) -> BackendResult<TextResult> {
        match self {
            Self::Node(backend) => backend.logs(provider_id, lines).await,
            Self::Fixture(backend) => backend.logs(provider_id, lines).await,
        }
    }

    pub async fn usage(&self, range: UsageRange) -> BackendResult<UsageSnapshot> {
        match self {
            Self::Node(backend) => backend.usage(range).await,
            Self::Fixture(backend) => backend.usage(range).await,
        }
    }

    pub async fn doctor(&self) -> BackendResult<TextResult> {
        match self {
            Self::Node(backend) => backend.doctor().await,
            Self::Fixture(backend) => backend.doctor().await,
        }
    }

    pub async fn health(
        &self,
        provider_id: Option<String>,
        probe: bool,
    ) -> BackendResult<TextResult> {
        match self {
            Self::Node(backend) => backend.health(provider_id.as_deref(), probe).await,
            Self::Fixture(backend) => backend.health(provider_id.as_deref(), probe).await,
        }
    }

    pub async fn execute(&self, action: &Action) -> BackendResult<TextResult> {
        match self {
            Self::Node(backend) => backend.execute(action).await,
            Self::Fixture(backend) => backend.execute(action).await,
        }
    }

    pub async fn execute_interactive(&self, action: &Action) -> BackendResult<TextResult> {
        match self {
            Self::Node(backend) => backend.execute_interactive(action).await,
            Self::Fixture(backend) => backend.execute_interactive(action).await,
        }
    }
}
