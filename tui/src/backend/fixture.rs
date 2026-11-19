use std::sync::{Arc, RwLock};
use std::time::SystemTime;

use crate::domain::{
    Account, AccountGroup, AccountHealth, AccountSnapshot, Action, ActionKind, ActivityDay,
    AuthState, AuthStatus, CacheUsage, CheckinStatus, CreditsSnapshot, ModelRef, ModelUsage,
    Provider, ProviderSnapshot, QuotaAccount, QuotaBucket, QuotaRow, TextResult, TimeRange,
    TokenUsage, ToolStats, ToolTotals, UsageRange, UsageSnapshot,
};

use super::{BackendError, BackendResult};

#[derive(Debug, Clone)]
pub struct FixtureBackend {
    read_only: bool,
    state: Arc<RwLock<FixtureState>>,
}

#[derive(Debug, Clone)]
struct FixtureState {
    providers: ProviderSnapshot,
    accounts: AccountSnapshot,
    credits: CreditsSnapshot,
}

impl FixtureBackend {
    pub fn new(read_only: bool) -> Self {
        Self {
            read_only,
            state: Arc::new(RwLock::new(fixture_state())),
        }
    }

    pub fn is_read_only(&self) -> bool {
        self.read_only
    }

    pub async fn providers(&self) -> BackendResult<ProviderSnapshot> {
        let state = self.read_state()?;
        let mut snapshot = state.providers.clone();
        snapshot.received_at = Some(SystemTime::now());
        Ok(snapshot)
    }

    pub async fn accounts(&self) -> BackendResult<AccountSnapshot> {
        let state = self.read_state()?;
        let mut snapshot = state.accounts.clone();
        snapshot.received_at = Some(SystemTime::now());
        Ok(snapshot)
    }

    pub async fn credits(&self) -> BackendResult<CreditsSnapshot> {
        let state = self.read_state()?;
        let mut snapshot = state.credits.clone();
        snapshot.received_at = Some(SystemTime::now());
        Ok(snapshot)
    }

    pub async fn usage(&self, range: UsageRange) -> BackendResult<UsageSnapshot> {
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_err(|error| BackendError::new(format!("系统时间无效：{error}")))?
            .as_millis() as u64;
        let factor = match range {
            UsageRange::Day => 0.15,
            UsageRange::Week => 1.0,
            UsageRange::Month => 4.0,
            UsageRange::All => 8.0,
        };
        let mut snapshot = fixture_usage();
        snapshot.range_kind = range;
        snapshot.range = TimeRange {
            from: range.start_timestamp_ms(now),
            to: now,
        };
        snapshot.received_at = Some(SystemTime::now());
        snapshot.sessions = scale(snapshot.sessions, factor);
        snapshot.subagents = scale(snapshot.subagents, factor);
        snapshot.prompts = scale(snapshot.prompts, factor);
        snapshot.steps = scale(snapshot.steps, factor);
        snapshot.tokens.input = scale(snapshot.tokens.input, factor);
        snapshot.tokens.output = scale(snapshot.tokens.output, factor);
        snapshot.tokens.reasoning = scale(snapshot.tokens.reasoning, factor);
        snapshot.tokens.cache.read = scale(snapshot.tokens.cache.read, factor);
        snapshot.tokens.cache.write = scale(snapshot.tokens.cache.write, factor);
        snapshot.tools.totals.calls = scale(snapshot.tools.totals.calls, factor);
        snapshot.tools.totals.succeeded = scale(snapshot.tools.totals.succeeded, factor);
        snapshot.tools.totals.failed = scale(snapshot.tools.totals.failed, factor);
        snapshot.tools.totals.unfinished = scale(snapshot.tools.totals.unfinished, factor);
        for day in &mut snapshot.activity {
            day.steps = scale(day.steps, factor);
        }
        for model in &mut snapshot.models {
            model.steps = scale(model.steps, factor);
            model.tokens.input = scale(model.tokens.input, factor);
            model.tokens.output = scale(model.tokens.output, factor);
            model.tokens.reasoning = scale(model.tokens.reasoning, factor);
            model.tokens.cache.read = scale(model.tokens.cache.read, factor);
            model.tokens.cache.write = scale(model.tokens.cache.write, factor);
        }
        Ok(snapshot)
    }

    pub async fn logs(&self, provider_id: &str, lines: usize) -> BackendResult<TextResult> {
        let state = self.read_state()?;
        if !state
            .providers
            .providers
            .iter()
            .any(|provider| provider.id == provider_id)
        {
            return Err(BackendError::new(format!("未知 provider：{provider_id}")));
        }
        let all = [
            "2026-11-05T00:00:00Z [demo] provider endpoint ready",
            "2026-11-05T00:00:01Z [demo] request accepted (no real request was sent)",
            "2026-11-05T00:00:02Z [demo] upstream returned 429; queued request will retry",
            "2026-11-05T00:00:03Z [demo] credential status refreshed",
            "2026-11-05T00:00:04Z [demo] health probe skipped in demo mode",
            "2026-11-05T00:00:05Z [demo] Authorization: Bearer demo-secret-value is redacted on display",
            "2026-11-05T00:00:06Z [demo] waiting for user action",
        ];
        let lines = lines.clamp(10, 2000);
        let start = all.len().saturating_sub(lines);
        Ok(TextResult {
            text: format!("{}\n", all[start..].join("\n")),
            exit_code: Some(0),
            truncated: false,
        })
    }

    pub async fn doctor(&self) -> BackendResult<TextResult> {
        Ok(TextResult {
            text: "router 自检（DEMO）\n────────────\n* node demo\n* router root: 匿名演示数据\n* 八家反代 + 统一网关: 模拟\n* opencode 配置: 模拟\n* DEMO 模式不访问真实凭证\n".into(),
            exit_code: Some(0),
            truncated: false,
        })
    }

    pub async fn health(
        &self,
        provider_id: Option<&str>,
        probe: bool,
    ) -> BackendResult<TextResult> {
        let id = provider_id.unwrap_or("全部来源");
        let text = if probe {
            format!(
                "AI 路由体检（DEMO）\n* {id} 真实试打模拟：成功\n* 未消耗任何真实额度\n* 未连接任何真实端点\n"
            )
        } else {
            format!(
                "AI 路由体检（DEMO）\n* {id} 端点模拟可达\n* 模型目录模拟正常\n* 凭证状态模拟\n* 未发送真实对话\n"
            )
        };
        Ok(TextResult {
            text,
            exit_code: Some(0),
            truncated: false,
        })
    }

    pub async fn execute(&self, action: &Action) -> BackendResult<TextResult> {
        if action.is_interactive() {
            return Err(BackendError::new("DEMO 交互动作必须通过终端挂起执行"));
        }
        if self.read_only
            && (action.is_write() || matches!(action.kind, ActionKind::Probe | ActionKind::Checkin))
        {
            return Err(BackendError::new("当前为只读模式"));
        }
        if action.kind == ActionKind::Checkin {
            return Err(BackendError::new("当前 DEMO 后端不支持签到"));
        }
        if action.kind == ActionKind::Probe {
            return self
                .health(action.provider_ids.first().map(String::as_str), true)
                .await;
        }

        let mut state = self
            .state
            .write()
            .map_err(|_| BackendError::new("DEMO 状态锁已损坏"))?;
        let target = action.provider_ids.first().cloned();
        if target.is_some()
            && !state
                .providers
                .providers
                .iter()
                .any(|provider| provider.id == target.as_deref().unwrap_or_default())
        {
            return Ok(TextResult {
                text: format!("DEMO: 未知 provider {}\n", target.unwrap_or_default()),
                exit_code: Some(1),
                truncated: false,
            });
        }

        let message = match action.kind {
            ActionKind::Start => {
                if let Some(id) = target.as_deref() {
                    if let Some(provider) = state.providers.provider_mut(id) {
                        provider.up = true;
                        provider.oc = true;
                        provider.models = Some(if provider.models.unwrap_or(0) == 0 {
                            8
                        } else {
                            provider.models.unwrap_or(8)
                        });
                        provider.pid = Some(4100);
                    }
                }
                "DEMO: provider 已启动（模拟）".to_string()
            }
            ActionKind::Stop => {
                if let Some(id) = target.as_deref() {
                    if let Some(provider) = state.providers.provider_mut(id) {
                        provider.up = false;
                        provider.oc = false;
                        provider.pid = None;
                        provider.models = None;
                    }
                }
                "DEMO: provider 已停止，客户端配置已同步（模拟）".to_string()
            }
            ActionKind::StopKeepOpenCode => {
                if let Some(id) = target.as_deref() {
                    if let Some(provider) = state.providers.provider_mut(id) {
                        provider.up = false;
                        provider.pid = None;
                        provider.models = None;
                    }
                }
                "DEMO: 进程已停止，opencode provider 保留（模拟）".to_string()
            }
            ActionKind::Restart => {
                if let Some(id) = target.as_deref() {
                    if let Some(provider) = state.providers.provider_mut(id) {
                        provider.up = true;
                        provider.oc = true;
                        provider.pid = Some(4200);
                    }
                }
                "DEMO: provider 已重启（模拟）".to_string()
            }
            ActionKind::OnlyEnable => {
                for provider in &mut state.providers.providers {
                    // 网关是叠加层：on/off 不改它，`on` 始终等于进程状态。
                    if provider.overlay() {
                        provider.on = provider.up;
                        continue;
                    }
                    provider.on = Some(provider.id.as_str()) == target.as_deref();
                    provider.up = provider.on;
                    provider.oc = provider.on;
                    if !provider.on {
                        provider.models = None;
                        provider.pid = None;
                    }
                }
                state.providers.enabled = target.iter().cloned().collect();
                "DEMO: 仅保留目标 provider，其余已关闭（模拟）".to_string()
            }
            ActionKind::Disable => {
                if let Some(id) = target.as_deref() {
                    if let Some(provider) = state.providers.provider_mut(id) {
                        provider.on = false;
                        provider.up = false;
                        provider.oc = false;
                        provider.pid = None;
                        provider.models = None;
                    }
                    state.providers.enabled.retain(|enabled| enabled != id);
                }
                "DEMO: provider 已关闭（模拟）".to_string()
            }
            ActionKind::EnableAll => {
                for provider in &mut state.providers.providers {
                    if provider.overlay() {
                        provider.on = provider.up;
                        continue;
                    }
                    provider.on = true;
                    provider.up = true;
                    provider.oc = true;
                    provider.pid.get_or_insert(4300);
                }
                state.providers.enabled = state
                    .providers
                    .providers
                    .iter()
                    .filter(|provider| !provider.overlay())
                    .map(|provider| provider.id.clone())
                    .collect();
                "DEMO: 全部 provider 已启用（模拟）".to_string()
            }
            ActionKind::DisableAll => {
                for provider in &mut state.providers.providers {
                    // `router none` 会停掉包括网关在内的所有进程；网关没有「开关」
                    // 可清，但它的 on 本来就等于进程状态，所以跟着进程走。
                    provider.up = false;
                    provider.pid = None;
                    provider.models = None;
                    provider.on = false;
                    // 网关的 opencode provider 只由 `gateway install/uninstall` 改，
                    // 不跟着 none 被移除。
                    if !provider.overlay() {
                        provider.oc = false;
                    }
                }
                state.providers.enabled.clear();
                "DEMO: 全部 provider 已关闭（模拟）".to_string()
            }
            ActionKind::Sync => {
                for provider in &mut state.providers.providers {
                    if provider.overlay() {
                        continue;
                    }
                    provider.oc = provider.on;
                }
                "DEMO: opencode 配置已同步（模拟）".to_string()
            }
            ActionKind::SwitchAccountPreview => {
                "DEMO: dry-run 成功；未修改账号或进程（模拟）".to_string()
            }
            ActionKind::SwitchAccount => {
                if let (Some(id), Some(key)) = (target.as_deref(), action.account_key.as_deref()) {
                    if let Some(group) = state
                        .accounts
                        .providers
                        .iter_mut()
                        .find(|group| group.id == id)
                    {
                        if !group.accounts.iter().any(|account| account.key == key) {
                            return Ok(TextResult {
                                text: format!("DEMO: 找不到账号 {key}\n"),
                                exit_code: Some(1),
                                truncated: false,
                            });
                        }
                        for account in &mut group.accounts {
                            account.active = account.key == key;
                            account.enabled = true;
                        }
                    }
                }
                "DEMO: 账号已切换并重启对应 provider（模拟）".to_string()
            }
            ActionKind::EnableAllAccounts => {
                if let Some(id) = target.as_deref() {
                    if let Some(group) = state
                        .accounts
                        .providers
                        .iter_mut()
                        .find(|group| group.id == id)
                    {
                        for account in &mut group.accounts {
                            account.enabled = true;
                        }
                    }
                }
                "DEMO: 账号池已恢复为全部参与轮询（模拟）".to_string()
            }
            ActionKind::Login => "DEMO: 登录完成（模拟）".to_string(),
            ActionKind::AddAccount => "DEMO: 账号已添加（模拟）".to_string(),
            ActionKind::Probe => unreachable!("probe returns above"),
            ActionKind::Checkin => unreachable!("checkin returns above"),
        };
        if matches!(action.kind, ActionKind::SwitchAccount | ActionKind::Login) {
            if let Some(id) = target.as_deref() {
                if let Some(provider) = state.providers.provider_mut(id) {
                    provider.auth = AuthStatus {
                        ok: true,
                        state: Some(AuthState::Valid),
                        expires_at: None,
                        label: "DEMO 已登录".into(),
                    };
                }
            }
        }
        Ok(TextResult {
            text: format!("{message}\n"),
            exit_code: Some(0),
            truncated: false,
        })
    }

    pub async fn execute_interactive(&self, action: &Action) -> BackendResult<TextResult> {
        if self.read_only {
            return Err(BackendError::new("当前为只读模式"));
        }
        if !action.is_interactive() {
            return Err(BackendError::new("该动作不是交互动作"));
        }
        let result = self.execute(action).await?;
        Ok(TextResult {
            text: format!(
                "DEMO 交互流程已结束（无真实浏览器/PAT）\n{}\n",
                result.text.trim_end()
            ),
            exit_code: result.exit_code,
            truncated: false,
        })
    }

    fn read_state(&self) -> BackendResult<std::sync::RwLockReadGuard<'_, FixtureState>> {
        self.state
            .read()
            .map_err(|_| BackendError::new("DEMO 状态锁已损坏"))
    }
}

fn auth(ok: bool, state: AuthState, label: &str) -> AuthStatus {
    AuthStatus {
        ok,
        state: Some(state),
        expires_at: None,
        label: label.to_string(),
    }
}

#[allow(clippy::too_many_arguments)]
fn provider(
    id: &str,
    title: &str,
    port: u16,
    on: bool,
    up: bool,
    models: Option<u32>,
    oc: bool,
    auth: AuthStatus,
) -> Provider {
    Provider {
        id: id.into(),
        title: title.into(),
        port,
        on,
        up,
        models,
        pid: up.then_some(4000 + u32::from(port) % 1000),
        pids: if up {
            vec![4000 + u32::from(port) % 1000]
        } else {
            Vec::new()
        },
        control: "spawn".into(),
        oc,
        oc_user_owned: false,
        auth,
    }
}

fn account(key: &str, name: &str, enabled: bool, active: bool, detail: &str) -> Account {
    Account {
        key: key.into(),
        name: name.into(),
        uid: Some(format!("00000000-0000-0000-0000-{:012}", key.len())),
        enabled,
        active,
        detail: Some(detail.into()),
        health: AccountHealth::default(),
    }
}

fn bucket(label: &str, total: f64, used: f64, remaining: f64, unit: &str) -> QuotaBucket {
    QuotaBucket {
        id: label.to_ascii_lowercase(),
        label: label.into(),
        total: Some(total),
        used: Some(used),
        remaining: Some(remaining),
        unit: unit.into(),
        reset_date: Some("2026-12-01".into()),
        expiring: None,
        expires_at: None,
    }
}

fn scale(value: u64, factor: f64) -> u64 {
    (value as f64 * factor).round() as u64
}

fn tokens(input: u64, output: u64, reasoning: u64, cache_read: u64) -> TokenUsage {
    TokenUsage {
        input,
        output,
        reasoning,
        cache: CacheUsage {
            read: cache_read,
            write: 1_000,
        },
    }
}

fn model(
    provider: &str,
    id: &str,
    steps: u64,
    input: u64,
    output: u64,
    reasoning: u64,
    cache_read: u64,
) -> ModelUsage {
    ModelUsage {
        model: ModelRef {
            id: id.into(),
            provider_id: provider.into(),
            variant: if steps > 150 { "high" } else { "default" }.into(),
        },
        steps,
        tokens: tokens(input, output, reasoning, cache_read),
        cost: 0.0,
    }
}

fn fixture_usage() -> UsageSnapshot {
    UsageSnapshot {
        range: TimeRange::default(),
        sessions: 12,
        subagents: 2,
        prompts: 46,
        steps: 780,
        tokens: tokens(120_000, 18_000, 24_000, 450_000),
        cost: 0.0,
        tools: ToolStats {
            mode: "summary".into(),
            totals: ToolTotals {
                calls: 120,
                succeeded: 116,
                failed: 3,
                unfinished: 1,
            },
        },
        active_days: 7,
        streak: 3,
        activity: vec![
            ActivityDay {
                date: "2026-10-30".into(),
                steps: 12,
            },
            ActivityDay {
                date: "2026-10-31".into(),
                steps: 30,
            },
            ActivityDay {
                date: "2026-11-01".into(),
                steps: 42,
            },
            ActivityDay {
                date: "2026-11-02".into(),
                steps: 80,
            },
            ActivityDay {
                date: "2026-11-03".into(),
                steps: 110,
            },
            ActivityDay {
                date: "2026-11-04".into(),
                steps: 190,
            },
            ActivityDay {
                date: "2026-11-05".into(),
                steps: 220,
            },
        ],
        models: vec![
            model(
                "codearts",
                "demo-code-model",
                240,
                45_000,
                5_000,
                8_000,
                200_000,
            ),
            model(
                "qoder-cn",
                "demo-qoder-model",
                180,
                30_000,
                4_500,
                6_000,
                120_000,
            ),
            model(
                "workbuddy",
                "demo-workbuddy-model",
                130,
                20_000,
                3_500,
                4_000,
                60_000,
            ),
            model(
                "trae-local",
                "demo-trae-model",
                100,
                12_000,
                2_500,
                3_000,
                40_000,
            ),
            model(
                "qoder",
                "demo-global-model",
                70,
                8_000,
                1_500,
                2_000,
                20_000,
            ),
            model("loomy", "demo-loomy-model", 50, 6_000, 1_200, 1_500, 15_000),
            model(
                "opencode",
                "demo-builtin-model",
                60,
                5_000,
                1_000,
                1_000,
                10_000,
            ),
        ],
        range_kind: UsageRange::Week,
        received_at: Some(SystemTime::now()),
        warnings: Vec::new(),
    }
}

fn fixture_state() -> FixtureState {
    let providers = vec![
        provider(
            "qoder-cn",
            "Qoder 国内版",
            8789,
            true,
            true,
            Some(11),
            true,
            auth(true, AuthState::Expiring, "DEMO 凭证剩 1 天"),
        ),
        provider(
            "qoder",
            "Qoder 国际版",
            8790,
            true,
            true,
            Some(1),
            true,
            auth(true, AuthState::Valid, "DEMO 凭证剩 29 天"),
        ),
        provider(
            "trae-local",
            "Trae",
            7863,
            true,
            true,
            Some(29),
            true,
            auth(true, AuthState::Expired, "DEMO 凭证已过期"),
        ),
        provider(
            "codearts",
            "CodeArts Agent",
            10087,
            true,
            false,
            None,
            false,
            auth(true, AuthState::Valid, "DEMO 账号池正常"),
        ),
        provider(
            "workbuddy",
            "WorkBuddy 国内版",
            8787,
            true,
            true,
            Some(31),
            true,
            auth(true, AuthState::Valid, "DEMO 凭证剩 29 天"),
        ),
        provider(
            "workbuddy-global",
            "WorkBuddy 国际版",
            8788,
            true,
            true,
            Some(10),
            true,
            auth(true, AuthState::Unknown, "DEMO 凭证状态未知"),
        ),
        provider(
            "zcode",
            "ZCode (Z.ai)",
            20131,
            true,
            true,
            Some(1),
            true,
            auth(true, AuthState::Valid, "DEMO 套餐正常"),
        ),
        provider(
            "loomy",
            "Loomy（讯飞）",
            8791,
            true,
            true,
            Some(6),
            true,
            auth(true, AuthState::Valid, "DEMO 已登录（193****1351）"),
        ),
        provider(
            "raccoon",
            "商汤小浣熊",
            8793,
            true,
            true,
            Some(9),
            true,
            auth(true, AuthState::Valid, "DEMO 已登录（个人版）"),
        ),
        provider(
            "gateway",
            "统一网关",
            8785,
            true,
            true,
            Some(96),
            true,
            auth(true, AuthState::Unknown, "DEMO 聚合 8 家反代"),
        ),
    ];
    let enabled = providers
        .iter()
        .filter(|provider| provider.on)
        .map(|provider| provider.id.clone())
        .collect();
    let provider_snapshot = ProviderSnapshot {
        schema_version: Some(1),
        generated_at: Some("2026-11-05T00:00:00Z".into()),
        enabled,
        providers,
        received_at: Some(SystemTime::now()),
        warnings: vec!["DEMO: CodeArts 当前为停止状态，符合演示漂移场景".into()],
    };

    let accounts = AccountSnapshot {
        schema_version: Some(1),
        generated_at: Some("2026-11-05T00:00:00Z".into()),
        providers: vec![
            AccountGroup {
                id: "qoder-cn".into(),
                title: "Qoder 国内版".into(),
                kind: "qoder".into(),
                switchable: false,
                accounts: vec![account(
                    "qoder-cn",
                    "example-user",
                    true,
                    true,
                    "单账号 · 剩 1 天",
                )],
            },
            AccountGroup {
                id: "qoder".into(),
                title: "Qoder 国际版".into(),
                kind: "qoder".into(),
                switchable: false,
                accounts: vec![account(
                    "qoder",
                    "example-global",
                    true,
                    true,
                    "单账号 · 剩 29 天",
                )],
            },
            AccountGroup {
                id: "trae-local".into(),
                title: "Trae".into(),
                kind: "trae".into(),
                switchable: true,
                accounts: vec![
                    account("slot-a", "demo-user-a", true, true, "335 积分 · 已过期"),
                    account(
                        "slot-b",
                        "demo-user-b",
                        true,
                        false,
                        "1078 积分 · 今日已签到",
                    ),
                ],
            },
            AccountGroup {
                id: "codearts".into(),
                title: "CodeArts Agent".into(),
                kind: "codearts".into(),
                switchable: true,
                accounts: vec![
                    account(
                        "account-a",
                        "demo-codearts-a",
                        true,
                        false,
                        "状态 ok · 6599 credits",
                    ),
                    account(
                        "account-b",
                        "demo-codearts-b",
                        true,
                        false,
                        "状态 ok · 120 credits",
                    ),
                ],
            },
            AccountGroup {
                id: "workbuddy".into(),
                title: "WorkBuddy 国内版".into(),
                kind: "workbuddy".into(),
                switchable: true,
                accounts: vec![
                    account("slot-a", "demo-user-a", true, true, "凭证剩 29 天"),
                    account("slot-b", "demo-user-b", true, false, "凭证剩 30 天"),
                ],
            },
            AccountGroup {
                id: "workbuddy-global".into(),
                title: "WorkBuddy 国际版".into(),
                kind: "workbuddy".into(),
                switchable: true,
                accounts: vec![account(
                    "slot-a",
                    "demo-global",
                    true,
                    true,
                    "凭证剩 364 天",
                )],
            },
            AccountGroup {
                id: "zcode".into(),
                title: "ZCode（Z.ai）".into(),
                kind: "zcode".into(),
                switchable: true,
                accounts: vec![account(
                    "(pinned)",
                    "固定凭据 plan-jwt.json",
                    true,
                    true,
                    "不跟随桌面端换号",
                )],
            },
            AccountGroup {
                id: "loomy".into(),
                title: "Loomy（讯飞）".into(),
                kind: "loomy".into(),
                switchable: false,
                accounts: vec![account(
                    "loomy-user",
                    "193****1351",
                    true,
                    true,
                    "单账号 · 登录态由 Loomy 桌面端维护",
                )],
            },
            AccountGroup {
                id: "raccoon".into(),
                title: "商汤小浣熊".into(),
                kind: "raccoon".into(),
                switchable: false,
                accounts: vec![account(
                    "raccoon-user",
                    "个人版",
                    true,
                    true,
                    "单账号 · 登录态由小浣熊桌面端维护",
                )],
            },
        ],
        received_at: Some(SystemTime::now()),
        warnings: Vec::new(),
    };

    let credits = CreditsSnapshot {
        rows: vec![
            QuotaRow {
                provider: "qoder-cn".into(),
                kind: "qoder".into(),
                title: "Qoder 国内版".into(),
                available: true,
                account: Some("example-user".into()),
                buckets: vec![bucket("加购额度", 800.0, 704.0, 96.0, "credits")],
                checkin: Some(CheckinStatus {
                    supported: false,
                    claimable: Some(false),
                    claimed: false,
                    reward_credits: Some(0.0),
                    note: Some("活动未开放".into()),
                    reason: None,
                }),
                fetched_at: Some("2026-11-05T00:00:00Z".into()),
                ..Default::default()
            },
            QuotaRow {
                provider: "qoder".into(),
                kind: "qoder".into(),
                title: "Qoder 国际版".into(),
                available: false,
                reason: Some("DEMO 凭证区域无签到接口".into()),
                fetched_at: Some("2026-11-05T00:00:00Z".into()),
                ..Default::default()
            },
            QuotaRow {
                provider: "trae-local".into(),
                kind: "trae".into(),
                title: "Trae".into(),
                available: true,
                accounts: vec![
                    QuotaAccount {
                        name: "demo-user-a".into(),
                        remaining: Some(335.0),
                        total: Some(1500.0),
                        unit: "credits".into(),
                        reset_date: Some("2026-12-01".into()),
                        packs: Some(4),
                        checkin: Some(CheckinStatus {
                            supported: true,
                            claimable: Some(false),
                            claimed: true,
                            reward_credits: Some(50.0),
                            note: None,
                            reason: None,
                        }),
                        ..Default::default()
                    },
                    QuotaAccount {
                        name: "demo-user-b".into(),
                        remaining: Some(1078.0),
                        total: Some(1500.0),
                        unit: "credits".into(),
                        packs: Some(11),
                        checkin: Some(CheckinStatus {
                            supported: true,
                            claimable: Some(true),
                            claimed: false,
                            reward_credits: Some(50.0),
                            note: None,
                            reason: None,
                        }),
                        ..Default::default()
                    },
                ],
                fetched_at: Some("2026-11-05T00:00:00Z".into()),
                ..Default::default()
            },
            QuotaRow {
                provider: "codearts".into(),
                kind: "codearts".into(),
                title: "CodeArts Agent".into(),
                available: true,
                accounts: vec![QuotaAccount {
                    name: "demo-codearts-a".into(),
                    remaining: Some(6599.25),
                    total: Some(6600.0),
                    unit: "credits".into(),
                    reset_date: Some("2026-11-24".into()),
                    expiring: Some(99.25),
                    ..Default::default()
                }],
                fetched_at: Some("2026-11-05T00:00:00Z".into()),
                ..Default::default()
            },
            QuotaRow {
                provider: "workbuddy".into(),
                kind: "workbuddy".into(),
                title: "WorkBuddy 国内版".into(),
                available: true,
                account: Some("demo-user-a".into()),
                service_running: Some(true),
                buckets: vec![
                    bucket("凭证有效期", 0.0, 0.0, 29.0, "days"),
                    bucket("续期时间", 0.0, 0.0, 80.0, "days"),
                ],
                fetched_at: Some("2026-11-05T00:00:00Z".into()),
                ..Default::default()
            },
            QuotaRow {
                provider: "workbuddy-global".into(),
                kind: "workbuddy".into(),
                title: "WorkBuddy 国际版".into(),
                available: true,
                account: Some("demo-global".into()),
                service_running: Some(true),
                buckets: vec![bucket("凭证有效期", 0.0, 0.0, 364.0, "days")],
                fetched_at: Some("2026-11-05T00:00:00Z".into()),
                ..Default::default()
            },
            QuotaRow {
                provider: "zcode".into(),
                kind: "zcode".into(),
                title: "ZCode（Z.ai）".into(),
                available: true,
                account: Some("default".into()),
                buckets: vec![bucket("GLM-5.3-Flash", 500.0, 0.0, 500.0, "M tok")],
                fetched_at: Some("2026-11-05T00:00:00Z".into()),
                ..Default::default()
            },
            QuotaRow {
                provider: "loomy".into(),
                kind: "loomy".into(),
                title: "Loomy（讯飞 iModel）".into(),
                available: true,
                account: Some("193****1351".into()),
                // 上游只给当前可用额，没有总额；用 0 表示分母未知
                buckets: vec![bucket("可用积分", 20000.0, 0.0, 20000.0, "credits")],
                fetched_at: Some("2026-11-05T00:00:00Z".into()),
                ..Default::default()
            },
            QuotaRow {
                provider: "raccoon".into(),
                kind: "raccoon".into(),
                title: "商汤小浣熊".into(),
                available: true,
                account: Some("个人版".into()),
                // 同上：只有可用积分，没有总额
                buckets: vec![bucket("可用积分", 9291.0, 0.0, 9291.0, "credits")],
                fetched_at: Some("2026-11-05T00:00:00Z".into()),
                ..Default::default()
            },
        ],
        received_at: Some(SystemTime::now()),
        warnings: Vec::new(),
    };

    FixtureState {
        providers: provider_snapshot,
        accounts,
        credits,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn demo_start_does_not_change_enabled_switch() {
        let backend = FixtureBackend::new(false);
        let before = backend.providers().await.unwrap();
        let provider = before.provider("codearts").unwrap();
        assert!(provider.on);
        assert!(!provider.up);

        backend
            .execute(&Action::one(ActionKind::Start, "codearts"))
            .await
            .unwrap();
        let after = backend.providers().await.unwrap();
        let provider = after.provider("codearts").unwrap();
        assert!(provider.on);
        assert!(provider.up);
    }

    #[tokio::test]
    async fn only_enable_is_exclusive_in_demo() {
        let backend = FixtureBackend::new(false);
        backend
            .execute(&Action::one(ActionKind::OnlyEnable, "qoder"))
            .await
            .unwrap();
        let snapshot = backend.providers().await.unwrap();
        assert_eq!(snapshot.enabled, vec!["qoder"]);
        assert!(snapshot
            .providers
            .iter()
            .filter(|provider| !provider.overlay())
            .all(|provider| provider.on == (provider.id == "qoder")));
        // 网关是叠加层：on/off 不改它，它的 on 始终跟随进程状态。
        let gateway = snapshot.provider("gateway").expect("gateway in demo");
        assert_eq!(gateway.on, gateway.up);
        assert!(!gateway.drift());
    }

    #[tokio::test]
    async fn disable_all_keeps_gateway_client_provider() {
        let backend = FixtureBackend::new(false);
        backend
            .execute(&Action::global(ActionKind::DisableAll))
            .await
            .unwrap();
        let snapshot = backend.providers().await.unwrap();
        assert!(snapshot.enabled.is_empty());
        let gateway = snapshot.provider("gateway").expect("gateway in demo");
        assert!(!gateway.up);
        assert!(!gateway.on);
        // 网关的 opencode provider 只由 gateway install/uninstall 改。
        assert!(gateway.oc);
    }

    #[tokio::test]
    async fn read_only_blocks_demo_writes() {
        let backend = FixtureBackend::new(true);
        let error = backend
            .execute(&Action::one(ActionKind::Restart, "qoder"))
            .await
            .unwrap_err();
        assert!(error.message.contains("只读"));
    }

    #[tokio::test]
    async fn account_preview_does_not_switch() {
        let backend = FixtureBackend::new(false);
        backend
            .execute(&Action::account(
                ActionKind::SwitchAccountPreview,
                "workbuddy",
                "slot-b",
            ))
            .await
            .unwrap();
        let snapshot = backend.accounts().await.unwrap();
        let group = snapshot.group("workbuddy").unwrap();
        assert!(group.accounts[0].active);
        assert!(!group.accounts[1].active);
    }
}
