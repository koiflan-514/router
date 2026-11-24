use std::fmt;
use std::time::SystemTime;

use serde::{Deserialize, Deserializer};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum AuthState {
    Valid,
    Expiring,
    Expired,
    Missing,
    #[default]
    Unknown,
}

impl<'de> Deserialize<'de> for AuthState {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "valid" => Self::Valid,
            "expiring" => Self::Expiring,
            "expired" => Self::Expired,
            "missing" => Self::Missing,
            _ => Self::Unknown,
        })
    }
}

impl AuthState {
    pub fn label(self) -> &'static str {
        match self {
            Self::Valid => "正常",
            Self::Expiring => "即将到期",
            Self::Expired => "已过期",
            Self::Missing => "未登录",
            Self::Unknown => "未知",
        }
    }

    pub fn is_problem(self) -> bool {
        matches!(self, Self::Expiring | Self::Expired | Self::Missing)
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct AuthStatus {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub state: Option<AuthState>,
    #[serde(default, rename = "expiresAt")]
    pub expires_at: Option<serde_json::Value>,
    #[serde(default)]
    pub label: String,
}

impl AuthStatus {
    pub fn effective_state(&self) -> AuthState {
        if let Some(state) = self.state {
            state
        } else if !self.ok {
            AuthState::Missing
        } else {
            AuthState::Unknown
        }
    }

    /// Legacy v0 has no structured state. We treat ok as a coarse fallback,
    /// never parse the human-readable label.
    pub fn display_label(&self) -> String {
        if self.label.is_empty() {
            self.effective_state().label().to_string()
        } else {
            self.label.clone()
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub on: bool,
    #[serde(default)]
    pub up: bool,
    #[serde(default)]
    pub models: Option<u32>,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub pids: Vec<u32>,
    #[serde(default)]
    pub control: String,
    #[serde(default)]
    pub oc: bool,
    #[serde(default)]
    pub oc_user_owned: bool,
    #[serde(default)]
    pub auth: AuthStatus,
}

impl Provider {
    pub fn client_label(&self) -> &'static str {
        if self.oc_user_owned {
            "用户自管"
        } else if self.oc {
            "已写入"
        } else {
            "未写入"
        }
    }

    /// 窄表格用的短标签：和 `client_label` 语义一致，只压缩「用户自管」。
    pub fn client_short(&self) -> &'static str {
        if self.oc_user_owned {
            "自管"
        } else if self.oc {
            "已写入"
        } else {
            "未写入"
        }
    }

    /// 网关是叠加层：`router.mjs list` 把它的 `on` 直接取进程状态，
    /// 它不参与 on/off 的开关语义，也不能用「开关≠进程」判断漂移。
    pub fn overlay(&self) -> bool {
        self.id == GATEWAY_PROVIDER_ID
    }

    /// 开关列的文案。网关没有「开/关」，只有「叠加」。
    pub fn switch_label(&self) -> &'static str {
        if self.overlay() {
            "叠加"
        } else if self.on {
            "开"
        } else {
            "关"
        }
    }

    pub fn drift(&self) -> bool {
        if self.overlay() {
            return false;
        }
        self.on != self.up || (self.on != self.oc && !self.oc_user_owned)
    }
}

/// `router.mjs` 里统一网关的 provider id。
pub const GATEWAY_PROVIDER_ID: &str = "gateway";

/// 额度采集器对 Trae 使用 `trae`，而 provider id 是 `trae-local`。
/// 两张表来自不同工具，展示与跳转时统一成 provider id。
pub fn canonical_provider_id(id: &str) -> &str {
    match id {
        "trae" => "trae-local",
        other => other,
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSnapshot {
    #[serde(default)]
    pub schema_version: Option<u32>,
    #[serde(default)]
    pub generated_at: Option<String>,
    #[serde(default)]
    pub enabled: Vec<String>,
    #[serde(default)]
    pub providers: Vec<Provider>,
    #[serde(skip)]
    pub received_at: Option<SystemTime>,
    #[serde(skip)]
    pub warnings: Vec<String>,
}

impl ProviderSnapshot {
    pub fn provider(&self, id: &str) -> Option<&Provider> {
        self.providers.iter().find(|provider| provider.id == id)
    }

    pub fn provider_mut(&mut self, id: &str) -> Option<&mut Provider> {
        self.providers.iter_mut().find(|provider| provider.id == id)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum HealthLevel {
    Ok,
    Warn,
    Error,
    #[default]
    Unknown,
}

impl<'de> Deserialize<'de> for HealthLevel {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "ok" => Self::Ok,
            "warn" => Self::Warn,
            "error" => Self::Error,
            _ => Self::Unknown,
        })
    }
}

impl HealthLevel {
    pub fn is_problem(self) -> bool {
        matches!(self, Self::Warn | Self::Error)
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct AccountHealth {
    pub level: HealthLevel,
    pub notes: Vec<String>,
}

impl AccountHealth {
    pub fn summary(&self) -> Option<String> {
        let notes: Vec<&str> = self
            .notes
            .iter()
            .map(String::as_str)
            .filter(|note| !note.trim().is_empty())
            .collect();
        if notes.is_empty() {
            None
        } else {
            Some(notes.join(" · "))
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Account {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub uid: Option<String>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub health: AccountHealth,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AccountGroup {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub switchable: bool,
    #[serde(default)]
    pub accounts: Vec<Account>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSnapshot {
    #[serde(default)]
    pub schema_version: Option<u32>,
    #[serde(default)]
    pub generated_at: Option<String>,
    #[serde(default)]
    pub providers: Vec<AccountGroup>,
    #[serde(skip)]
    pub received_at: Option<SystemTime>,
    #[serde(skip)]
    pub warnings: Vec<String>,
}

impl AccountSnapshot {
    #[cfg(test)]
    pub fn group(&self, id: &str) -> Option<&AccountGroup> {
        self.providers.iter().find(|group| group.id == id)
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CheckinStatus {
    #[serde(default)]
    pub supported: bool,
    #[serde(default)]
    pub claimable: Option<bool>,
    #[serde(default)]
    pub claimed: bool,
    #[serde(default)]
    pub reward_credits: Option<f64>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

impl CheckinStatus {
    /// 上游并不总是返回 `claimable`（Trae 只给 `claimed` 和奖励值）。
    /// 缺省时只在「支持签到 + 今天没签 + 奖励已知且大于 0」时推断为可领取；
    /// CodeArts 的奖励固定是 0（网关不返回数值），推断成可领取会让 KPI 虚高。
    pub fn is_claimable(&self) -> bool {
        self.claimable.unwrap_or(
            self.supported && !self.claimed && self.reward_credits.is_some_and(|value| value > 0.0),
        )
    }

    pub fn summary(&self) -> String {
        if let Some(note) = self.note.as_ref().filter(|value| !value.is_empty()) {
            return note.clone();
        }
        if let Some(reason) = self.reason.as_ref().filter(|value| !value.is_empty()) {
            return reason.clone();
        }
        if !self.supported {
            return "不支持签到".to_string();
        }
        if self.claimed {
            return "今日已签到".to_string();
        }
        if self.claimable == Some(false) {
            return "不可领取".to_string();
        }
        if self.is_claimable() {
            return match self.reward_credits {
                Some(value) if value > 0.0 => format!("可领取 {}", format_number(value)),
                _ => "可领取".to_string(),
            };
        }
        // 支持签到但上游没给奖励数值：如实说「未签到」，不假装可领取。
        "今日未签到".to_string()
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct QuotaBucket {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub total: Option<f64>,
    #[serde(default)]
    pub used: Option<f64>,
    #[serde(default)]
    pub remaining: Option<f64>,
    #[serde(default)]
    pub unit: String,
    #[serde(default)]
    pub reset_date: Option<String>,
    #[serde(default)]
    pub expiring: Option<f64>,
    #[serde(default)]
    pub expires_at: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct QuotaAccount {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub remaining: Option<f64>,
    #[serde(default)]
    pub total: Option<f64>,
    #[serde(default)]
    pub unit: String,
    #[serde(default)]
    pub reset_date: Option<String>,
    #[serde(default)]
    pub expiring: Option<f64>,
    #[serde(default)]
    pub packs: Option<u32>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default)]
    pub cooling: bool,
    #[serde(default)]
    pub quota_exhausted: bool,
    #[serde(default)]
    pub checkin: Option<CheckinStatus>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct QuotaRow {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub available: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub detail: Vec<String>,
    #[serde(default)]
    pub account: Option<String>,
    #[serde(default)]
    pub service_running: Option<bool>,
    #[serde(default)]
    pub quota_exhausted: bool,
    #[serde(default)]
    pub buckets: Vec<QuotaBucket>,
    #[serde(default)]
    pub accounts: Vec<QuotaAccount>,
    #[serde(default)]
    pub checkin: Option<CheckinStatus>,
    #[serde(default)]
    pub fetched_at: Option<String>,
}

impl QuotaRow {
    pub fn claimable_count(&self) -> usize {
        let direct = usize::from(
            self.checkin
                .as_ref()
                .is_some_and(|checkin| checkin.supported && checkin.is_claimable()),
        );
        // 已停用的账号即使能领也不会被调度；把它算进「可领取」只会让顶部数字虚高。
        // 行内状态同样不给停用账号标「可领取」，两边保持一致。
        direct
            + self
                .accounts
                .iter()
                .filter(|account| {
                    !account.disabled
                        && account
                            .checkin
                            .as_ref()
                            .is_some_and(|checkin| checkin.supported && checkin.is_claimable())
                })
                .count()
    }

    pub fn status_summary(&self) -> String {
        if !self.available {
            return self
                .reason
                .clone()
                .filter(|reason| !reason.is_empty())
                .unwrap_or_else(|| "不可用".to_string());
        }
        if let Some(running) = self.service_running {
            if !running {
                return "服务未运行".to_string();
            }
        }
        if self.kind == "workbuddy" {
            return if self.service_running == Some(true) {
                "服务在线 · 凭证有效期".to_string()
            } else {
                "凭证可读".to_string()
            };
        }
        // 额度耗尽比签到说明更重要：上游把签到接口 404 写成 note 时，
        // 只看签到状态会把「已经用不了」显示成「没有签到活动」。
        if self.quota_exhausted {
            return "额度已耗尽".to_string();
        }
        if let Some(checkin) = &self.checkin {
            return checkin.summary();
        }
        if self.accounts.iter().any(|account| account.error.is_some()) {
            return "部分账号查询失败".to_string();
        }
        "正常".to_string()
    }
}

#[derive(Debug, Clone, Default)]
pub struct CreditsSnapshot {
    pub rows: Vec<QuotaRow>,
    pub received_at: Option<SystemTime>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct TextResult {
    pub text: String,
    pub exit_code: Option<i32>,
    pub truncated: bool,
}

impl TextResult {
    pub fn succeeded(&self) -> bool {
        self.exit_code == Some(0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionRisk {
    Normal,
    High,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionKind {
    Start,
    Stop,
    StopKeepOpenCode,
    Restart,
    OnlyEnable,
    Disable,
    EnableAll,
    DisableAll,
    Sync,
    SwitchAccountPreview,
    SwitchAccount,
    EnableAllAccounts,
    Login,
    AddAccount,
    Probe,
    Checkin,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Action {
    pub kind: ActionKind,
    pub provider_ids: Vec<String>,
    pub account_key: Option<String>,
}

impl Action {
    pub fn one(kind: ActionKind, provider_id: impl Into<String>) -> Self {
        Self {
            kind,
            provider_ids: vec![provider_id.into()],
            account_key: None,
        }
    }

    pub fn global(kind: ActionKind) -> Self {
        Self {
            kind,
            provider_ids: Vec::new(),
            account_key: None,
        }
    }

    pub fn account(
        kind: ActionKind,
        provider_id: impl Into<String>,
        account_key: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            provider_ids: vec![provider_id.into()],
            account_key: Some(account_key.into()),
        }
    }

    pub fn risk(&self) -> ActionRisk {
        match self.kind {
            ActionKind::OnlyEnable
            | ActionKind::EnableAll
            | ActionKind::DisableAll
            | ActionKind::EnableAllAccounts
            | ActionKind::Probe
            | ActionKind::Checkin => ActionRisk::High,
            _ => ActionRisk::Normal,
        }
    }

    pub fn is_interactive(&self) -> bool {
        matches!(self.kind, ActionKind::Login | ActionKind::AddAccount)
    }

    pub fn is_write(&self) -> bool {
        matches!(
            self.kind,
            ActionKind::Start
                | ActionKind::Stop
                | ActionKind::StopKeepOpenCode
                | ActionKind::Restart
                | ActionKind::OnlyEnable
                | ActionKind::Disable
                | ActionKind::EnableAll
                | ActionKind::DisableAll
                | ActionKind::Sync
                | ActionKind::SwitchAccount
                | ActionKind::EnableAllAccounts
                | ActionKind::Login
                | ActionKind::AddAccount
                | ActionKind::Checkin
        )
    }

    pub fn title(&self) -> &'static str {
        match self.kind {
            ActionKind::Start => "启动",
            ActionKind::Stop => "停止",
            ActionKind::StopKeepOpenCode => "停止并保留客户端",
            ActionKind::Restart => "重启",
            ActionKind::OnlyEnable => "仅启用此家",
            ActionKind::Disable => "关闭此家",
            ActionKind::EnableAll => "全部启用",
            ActionKind::DisableAll => "全部关闭",
            ActionKind::Sync => "同步配置",
            ActionKind::SwitchAccountPreview => "预览切换账号",
            ActionKind::SwitchAccount => "切换账号",
            ActionKind::EnableAllAccounts => "恢复全部账号",
            ActionKind::Login => "登录",
            ActionKind::AddAccount => "添加账号",
            ActionKind::Probe => "真实试打",
            ActionKind::Checkin => "签到",
        }
    }

    pub fn command_preview(&self) -> String {
        let provider = self.provider_ids.first().cloned().unwrap_or_default();
        match self.kind {
            ActionKind::Start => format!("node router.mjs up {provider} --no-login"),
            ActionKind::Stop => format!("node router.mjs down {provider}"),
            ActionKind::StopKeepOpenCode => {
                format!("node router.mjs down {provider} --keep-oc")
            }
            ActionKind::Restart => format!("node router.mjs restart {provider} --no-login"),
            ActionKind::OnlyEnable => format!("node router.mjs on {provider} --no-login"),
            ActionKind::Disable => format!("node router.mjs off {provider}"),
            ActionKind::EnableAll => "node router.mjs all --no-login".to_string(),
            ActionKind::DisableAll => "node router.mjs none".to_string(),
            ActionKind::Sync => "node router.mjs sync".to_string(),
            ActionKind::SwitchAccountPreview => format!(
                "node router.mjs account {provider} {} --dry-run --json",
                self.account_key.as_deref().unwrap_or("<账号>")
            ),
            ActionKind::SwitchAccount => format!(
                "node router.mjs account {provider} {} --json",
                self.account_key.as_deref().unwrap_or("<账号>")
            ),
            ActionKind::EnableAllAccounts => {
                format!("node router.mjs account {provider} --all --json")
            }
            ActionKind::Login => format!("node router.mjs login {provider}"),
            ActionKind::AddAccount => format!("node router.mjs account add {provider}"),
            ActionKind::Probe => format!("node scripts/health.mjs {provider}"),
            ActionKind::Checkin => {
                "node integrations/qodbuddy2pi/assets/qoder2pi credits checkin".to_string()
            }
        }
    }

    pub fn refresh_targets(&self) -> RefreshTargets {
        match self.kind {
            ActionKind::SwitchAccountPreview => RefreshTargets::default(),
            ActionKind::SwitchAccount
            | ActionKind::EnableAllAccounts
            | ActionKind::Login
            | ActionKind::AddAccount => RefreshTargets {
                providers: true,
                accounts: true,
                credits: true,
            },
            ActionKind::Start
            | ActionKind::Stop
            | ActionKind::StopKeepOpenCode
            | ActionKind::Restart => RefreshTargets {
                providers: true,
                accounts: false,
                credits: true,
            },
            ActionKind::Disable
            | ActionKind::OnlyEnable
            | ActionKind::EnableAll
            | ActionKind::DisableAll
            | ActionKind::Sync => RefreshTargets {
                providers: true,
                accounts: false,
                credits: false,
            },
            ActionKind::Probe | ActionKind::Checkin => RefreshTargets {
                providers: false,
                accounts: false,
                credits: true,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct RefreshTargets {
    pub providers: bool,
    pub accounts: bool,
    pub credits: bool,
}

pub fn format_number(value: f64) -> String {
    if !value.is_finite() {
        return "—".to_string();
    }
    if value.fract().abs() < f64::EPSILON {
        format!("{value:.0}")
    } else {
        let text = format!("{value:.2}");
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

pub fn format_quota_remaining(value: Option<f64>, unit: &str) -> String {
    match value {
        Some(number) => {
            if unit.is_empty() {
                format_number(number)
            } else {
                format!("{} {}", format_number(number), unit)
            }
        }
        None => "—".to_string(),
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum UsageRange {
    Day,
    #[default]
    Week,
    Month,
    All,
}

impl UsageRange {
    pub fn label(self) -> &'static str {
        match self {
            Self::Day => "近 24 小时",
            Self::Week => "近 7 天",
            Self::Month => "近 30 天",
            Self::All => "全部历史",
        }
    }

    pub fn next(self) -> Self {
        match self {
            Self::Day => Self::Week,
            Self::Week => Self::Month,
            Self::Month => Self::All,
            Self::All => Self::Day,
        }
    }

    pub fn start_timestamp_ms(self, now_ms: u64) -> u64 {
        match self {
            Self::Day => now_ms.saturating_sub(86_400_000),
            Self::Week => now_ms.saturating_sub(7 * 86_400_000),
            Self::Month => now_ms.saturating_sub(30 * 86_400_000),
            Self::All => 0,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
    pub reasoning: u64,
    pub cache: CacheUsage,
}

impl TokenUsage {
    pub fn visible_total(&self) -> u64 {
        self.input
            .saturating_add(self.output)
            .saturating_add(self.reasoning)
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct CacheUsage {
    pub read: u64,
    pub write: u64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct TimeRange {
    pub from: u64,
    pub to: u64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ToolStats {
    pub mode: String,
    pub totals: ToolTotals,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ToolTotals {
    pub calls: u64,
    pub succeeded: u64,
    pub failed: u64,
    pub unfinished: u64,
}

impl ToolTotals {
    pub fn success_rate(&self) -> Option<f64> {
        if self.calls == 0 {
            None
        } else {
            Some(self.succeeded as f64 / self.calls as f64)
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ActivityDay {
    pub date: String,
    pub steps: u64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ModelRef {
    pub id: String,
    #[serde(rename = "providerID")]
    pub provider_id: String,
    pub variant: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ModelUsage {
    pub model: ModelRef,
    pub steps: u64,
    pub tokens: TokenUsage,
    pub cost: f64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct UsageSnapshot {
    pub range: TimeRange,
    pub sessions: u64,
    pub subagents: u64,
    pub prompts: u64,
    pub steps: u64,
    pub tokens: TokenUsage,
    pub cost: f64,
    pub tools: ToolStats,
    #[serde(rename = "activeDays")]
    pub active_days: u64,
    pub streak: u64,
    pub activity: Vec<ActivityDay>,
    pub models: Vec<ModelUsage>,
    #[serde(skip)]
    pub range_kind: UsageRange,
    #[serde(skip)]
    pub received_at: Option<SystemTime>,
    #[serde(skip)]
    pub warnings: Vec<String>,
}

/// Convert a quota expiry value to a compact UTC label. Accepts Unix seconds,
/// Unix milliseconds, or an RFC 3339-like string.
pub fn format_expiry_at(value: &serde_json::Value) -> Option<String> {
    let millis = if let Some(number) = value.as_f64() {
        if !number.is_finite() || number <= 0.0 {
            return None;
        }
        if number < 1e12 {
            number * 1000.0
        } else {
            number
        }
    } else {
        let text = value.as_str()?;
        let parsed =
            time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339)
                .ok()?;
        parsed.unix_timestamp() as f64 * 1000.0
    };
    let seconds = (millis / 1000.0) as i64;
    let datetime = time::OffsetDateTime::from_unix_timestamp(seconds).ok()?;
    Some(format!(
        "{:04}-{:02}-{:02} {:02}:{:02} UTC",
        datetime.year(),
        u8::from(datetime.month()),
        datetime.day(),
        datetime.hour(),
        datetime.minute()
    ))
}

pub fn format_compact(value: u64) -> String {
    const THOUSAND: f64 = 1_000.0;
    const MILLION: f64 = 1_000_000.0;
    const BILLION: f64 = 1_000_000_000.0;
    let value = value as f64;
    if value >= BILLION {
        format!("{:.1}B", value / BILLION)
    } else if value >= MILLION {
        format!("{:.1}M", value / MILLION)
    } else if value >= THOUSAND {
        format!("{:.1}K", value / THOUSAND)
    } else {
        format!("{value:.0}")
    }
}

pub fn format_percent(value: Option<f64>) -> String {
    value
        .filter(|value| value.is_finite())
        .map(|value| format!("{:.1}%", value * 100.0))
        .unwrap_or_else(|| "—".to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlatformCapability {
    Supported,
    Unsupported(&'static str),
}

impl PlatformCapability {
    pub fn login() -> Self {
        if cfg!(windows) {
            Self::Supported
        } else {
            Self::Unsupported("登录流程依赖本机 provider 工具，Linux 上仅按实际命令是否可用执行")
        }
    }

    pub fn autostart() -> Self {
        if cfg!(windows) {
            Self::Supported
        } else {
            Self::Unsupported("登录自启当前仅支持 Windows 计划任务")
        }
    }
}

impl fmt::Display for AuthState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.label())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_unknown_string_does_not_fail_deserialization() {
        let auth: AuthStatus =
            serde_json::from_str(r#"{"ok":true,"state":"future-state","label":"x"}"#).unwrap();
        assert_eq!(auth.effective_state(), AuthState::Unknown);
    }

    #[test]
    fn legacy_auth_uses_ok_only_as_coarse_fallback() {
        let auth: AuthStatus = serde_json::from_str(r#"{"ok":false,"label":"已过期"}"#).unwrap();
        assert_eq!(auth.effective_state(), AuthState::Missing);
        assert_eq!(auth.display_label(), "已过期");
    }

    #[test]
    fn null_models_is_not_zero() {
        let provider: Provider = serde_json::from_str(r#"{"id":"p","models":null}"#).unwrap();
        assert_eq!(provider.models, None);
    }

    #[test]
    fn numbers_are_displayed_without_float_noise() {
        assert_eq!(format_number(6599.25), "6599.25");
        assert_eq!(format_number(10.0), "10");
    }

    #[test]
    fn workbuddy_status_is_credential_days_not_checkin() {
        let row: QuotaRow = serde_json::from_value(serde_json::json!({
            "provider": "workbuddy",
            "kind": "workbuddy",
            "available": true,
            "serviceRunning": true,
            "buckets": [
                {"id":"credential","label":"凭证有效期","remaining":28,"unit":"天","expiresAt":1796355442639_u64},
                {"id":"refresh","label":"续期有效期","remaining":58,"unit":"天","expiresAt":1798947441639_u64}
            ],
            "checkin": {"supported": false, "claimed": false, "rewardCredits": 0}
        }))
        .unwrap();
        assert_eq!(row.status_summary(), "服务在线 · 凭证有效期");
        assert_eq!(
            format_expiry_at(row.buckets[0].expires_at.as_ref().unwrap()).as_deref(),
            Some("2026-12-04 03:37 UTC")
        );
        assert_eq!(
            format_expiry_at(row.buckets[1].expires_at.as_ref().unwrap()).as_deref(),
            Some("2027-01-03 03:37 UTC")
        );
    }

    #[test]
    fn quota_zero_is_distinct_from_missing() {
        assert_eq!(format_quota_remaining(Some(0.0), "credits"), "0 credits");
        assert_eq!(format_quota_remaining(None, "credits"), "—");
    }

    #[test]
    fn action_commands_use_expected_safety_flags() {
        assert!(Action::one(ActionKind::Start, "qoder")
            .command_preview()
            .contains("--no-login"));
        assert!(Action::one(ActionKind::Stop, "qoder")
            .command_preview()
            .contains("down qoder"));
        assert!(Action::one(ActionKind::StopKeepOpenCode, "qoder")
            .command_preview()
            .contains("--keep-oc"));
    }

    #[test]
    fn expiry_values_accept_milliseconds_and_show_utc() {
        let value = serde_json::json!(1796355442639_u64);
        assert_eq!(
            format_expiry_at(&value).as_deref(),
            Some("2026-12-04 03:37 UTC")
        );
        let seconds = serde_json::json!(1796355442_u64);
        assert_eq!(
            format_expiry_at(&seconds).as_deref(),
            Some("2026-12-04 03:37 UTC")
        );
    }

    #[test]
    fn usage_metrics_have_explicit_semantics() {
        assert_eq!(
            UsageRange::Week.start_timestamp_ms(8 * 86_400_000),
            86_400_000
        );
        assert_eq!(UsageRange::All.start_timestamp_ms(123), 0);
        let totals = ToolTotals {
            calls: 200,
            succeeded: 190,
            failed: 9,
            unfinished: 1,
        };
        assert_eq!(format_percent(totals.success_rate()), "95.0%");
        let usage = TokenUsage {
            input: 100,
            output: 20,
            reasoning: 5,
            cache: CacheUsage {
                read: 500,
                write: 0,
            },
        };
        assert_eq!(usage.visible_total(), 125);
        assert_eq!(format_compact(1_500_000), "1.5M");
        assert_eq!(format_compact(900), "900");
    }

    #[test]
    fn action_risk_and_interaction_are_explicit() {
        assert_eq!(
            Action::one(ActionKind::OnlyEnable, "qoder").risk(),
            ActionRisk::High
        );
        assert!(Action::one(ActionKind::Login, "qoder").is_interactive());
        assert!(!Action::one(ActionKind::Sync, "qoder").is_interactive());
        assert!(
            !Action::account(ActionKind::SwitchAccountPreview, "workbuddy", "slot-a").is_write()
        );
    }

    #[test]
    fn gateway_is_an_overlay_not_a_switchable_provider() {
        let gateway: Provider = serde_json::from_str(
            r#"{"id":"gateway","title":"统一网关","on":true,"up":true,"oc":true}"#,
        )
        .unwrap();
        assert!(gateway.overlay());
        assert_eq!(gateway.switch_label(), "叠加");
        // 网关的 on 就是进程状态；即使和 oc 不一致也不能报漂移。
        let stopped: Provider =
            serde_json::from_str(r#"{"id":"gateway","on":false,"up":false,"oc":true}"#).unwrap();
        assert!(!stopped.drift());

        let normal: Provider =
            serde_json::from_str(r#"{"id":"qoder","on":true,"up":false,"oc":true}"#).unwrap();
        assert!(!normal.overlay());
        assert_eq!(normal.switch_label(), "开");
        assert!(normal.drift());
    }

    #[test]
    fn quota_claims_are_inferred_when_upstream_omits_claimable() {
        // Trae 的采集器只给 claimed，没有 claimable。
        let pending: CheckinStatus =
            serde_json::from_str(r#"{"supported":true,"claimed":false,"rewardCredits":100}"#)
                .unwrap();
        assert!(pending.is_claimable());
        assert!(pending.summary().contains("可领取"));
        let done: CheckinStatus =
            serde_json::from_str(r#"{"supported":true,"claimed":true,"rewardCredits":100}"#)
                .unwrap();
        assert!(!done.is_claimable());
        let unsupported: CheckinStatus =
            serde_json::from_str(r#"{"supported":false,"claimed":false}"#).unwrap();
        assert!(!unsupported.is_claimable());
    }

    #[test]
    fn exhausted_quota_outranks_checkin_note() {
        let row: QuotaRow = serde_json::from_value(serde_json::json!({
            "provider": "qoder",
            "kind": "qoder",
            "available": true,
            "quotaExhausted": true,
            "checkin": {"supported": false, "note": "该区域没有签到接口（活动只在网页里）"}
        }))
        .unwrap();
        assert_eq!(row.status_summary(), "额度已耗尽");
    }

    #[test]
    fn account_health_is_parsed_and_summarized() {
        let account: Account = serde_json::from_str(
            r#"{"key":"a","name":"x","health":{"level":"error","notes":["积分为 0","已停用"]}}"#,
        )
        .unwrap();
        assert_eq!(account.health.level, HealthLevel::Error);
        assert!(account.health.level.is_problem());
        assert_eq!(
            account.health.summary().as_deref(),
            Some("积分为 0 · 已停用")
        );

        // 未知 level 不能导致整行解析失败。
        let unknown: Account =
            serde_json::from_str(r#"{"key":"a","health":{"level":"future","notes":[]}}"#).unwrap();
        assert_eq!(unknown.health.level, HealthLevel::Unknown);
        assert!(!unknown.health.level.is_problem());
        assert!(unknown.health.summary().is_none());
    }

    #[test]
    fn quota_provider_ids_are_canonicalized() {
        assert_eq!(canonical_provider_id("trae"), "trae-local");
        assert_eq!(canonical_provider_id("qoder-cn"), "qoder-cn");
    }
}
