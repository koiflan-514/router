use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

use crate::backend::{BackendError, BackendResult};
use crate::cli::Appearance;
use crate::domain::{
    Account, AccountGroup, AccountSnapshot, Action, ActionKind, ActionRisk, CreditsSnapshot,
    ModelUsage, Provider, ProviderSnapshot, QuotaRow, TextResult, UsageRange, UsageSnapshot,
};
use crate::redact::sanitize_lines;

const NOTICE_TTL: Duration = Duration::from_secs(12);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Page {
    Overview,
    Providers,
    Credits,
    Accounts,
    Logs,
    Diagnostics,
    Usage,
}

impl Page {
    pub const ALL: [Self; 7] = [
        Self::Overview,
        Self::Providers,
        Self::Credits,
        Self::Accounts,
        Self::Logs,
        Self::Diagnostics,
        Self::Usage,
    ];

    pub fn title(self) -> &'static str {
        match self {
            Self::Overview => "总览",
            Self::Providers => "服务",
            Self::Credits => "额度",
            Self::Accounts => "账号",
            Self::Logs => "日志",
            Self::Diagnostics => "诊断",
            Self::Usage => "用量",
        }
    }

    pub fn from_number(number: char) -> Option<Self> {
        match number {
            '1' => Some(Self::Overview),
            '2' => Some(Self::Providers),
            '3' => Some(Self::Credits),
            '4' => Some(Self::Accounts),
            '5' => Some(Self::Logs),
            '6' => Some(Self::Diagnostics),
            '7' => Some(Self::Usage),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AppInfo {
    pub backend_label: &'static str,
    pub root: String,
    pub node: String,
    pub demo: bool,
    pub read_only: bool,
    pub ascii: bool,
    pub no_color: bool,
    pub appearance: Appearance,
    pub refresh_secs: u64,
}

#[derive(Debug)]
pub struct Resource<T> {
    pub data: Option<T>,
    pub last_success: Option<Instant>,
    pub error: Option<String>,
    pub refreshing: bool,
    pub request_id: u64,
}

impl<T> Default for Resource<T> {
    fn default() -> Self {
        Self {
            data: None,
            last_success: None,
            error: None,
            refreshing: false,
            request_id: 0,
        }
    }
}

impl<T> Resource<T> {
    fn begin(&mut self, request_id: u64) {
        self.refreshing = true;
        self.request_id = request_id;
        self.error = None;
    }

    fn succeed(&mut self, data: T) {
        self.data = Some(data);
        self.last_success = Some(Instant::now());
        self.error = None;
        self.refreshing = false;
    }

    fn fail(&mut self, error: String) {
        self.error = Some(error);
        self.refreshing = false;
    }
}

#[derive(Debug, Clone)]
pub struct SelectedAccount<'a> {
    pub group: &'a AccountGroup,
    pub account: &'a Account,
}

#[derive(Debug, Clone)]
pub struct QuotaLine {
    pub provider: String,
    pub title: String,
    pub source: String,
    pub remaining: Option<f64>,
    pub total: Option<f64>,
    pub unit: String,
    pub status: String,
    pub fetched_at: Option<String>,
    pub detail: String,
}

#[derive(Debug)]
pub struct ConfirmDialog {
    pub action: Action,
    pub title: String,
    pub body: String,
    pub confirm_focused: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputPurpose {
    LogFilter,
}

#[derive(Debug)]
pub struct InputDialog {
    pub title: String,
    pub value: String,
    pub purpose: InputPurpose,
}

#[derive(Debug)]
pub enum Modal {
    Confirm(ConfirmDialog),
    Help,
    Detail {
        title: String,
        text: String,
        scroll: u16,
    },
    Input(InputDialog),
}

#[derive(Debug, Clone)]
pub struct Notice {
    pub text: String,
    pub error: bool,
    pub created: Instant,
}

#[derive(Debug, Clone)]
pub struct ActiveTask {
    pub id: u64,
    pub action: Action,
    pub started: Instant,
}

#[derive(Debug, Clone, Default)]
pub struct ActionResultView {
    pub title: String,
    pub result: TextResult,
}

#[derive(Debug, Clone)]
pub enum AppEffect {
    RunAction { task_id: u64, action: Action },
    RunInteractive { task_id: u64, action: Action },
    Quit,
}

#[derive(Debug, Clone)]
pub enum RefreshRequest {
    Providers(u64),
    Accounts(u64),
    Credits(u64),
    Usage(u64),
    Logs {
        request_id: u64,
        provider_id: String,
        lines: usize,
    },
    Doctor(u64),
    Health {
        request_id: u64,
        provider_id: Option<String>,
    },
}

#[derive(Debug)]
pub enum AppMessage {
    Providers {
        request_id: u64,
        result: BackendResult<ProviderSnapshot>,
    },
    Accounts {
        request_id: u64,
        result: BackendResult<AccountSnapshot>,
    },
    Credits {
        request_id: u64,
        result: BackendResult<CreditsSnapshot>,
    },
    Usage {
        request_id: u64,
        result: BackendResult<UsageSnapshot>,
    },
    Logs {
        request_id: u64,
        provider_id: String,
        result: BackendResult<TextResult>,
    },
    Diagnostics {
        request_id: u64,
        title: String,
        result: BackendResult<TextResult>,
    },
    ActionDone {
        task_id: u64,
        result: BackendResult<TextResult>,
    },
    Interrupt,
}

pub struct App {
    pub info: AppInfo,
    pub page: Page,
    pub providers: Resource<ProviderSnapshot>,
    pub accounts: Resource<AccountSnapshot>,
    pub credits: Resource<CreditsSnapshot>,
    pub usage: Resource<UsageSnapshot>,
    pub usage_range: UsageRange,
    pub usage_model_cursor: usize,
    pub provider_cursor: usize,
    pub account_cursor: usize,
    pub quota_cursor: usize,
    pub log_lines: Vec<String>,
    pub log_filter: String,
    pub log_follow: bool,
    pub log_match: Option<usize>,
    pub log_scroll: u16,
    pub log_max_scroll: u16,
    pub log_view_height: u16,
    pub log_error: Option<String>,
    pub log_last_success: Option<Instant>,
    pub log_refreshing: bool,
    pub log_request_id: u64,
    pub loaded_log_provider: Option<String>,
    pub log_lines_per_fetch: usize,
    pub diag: Resource<TextResult>,
    pub diag_title: String,
    pub diag_scroll: u16,
    pub modal: Option<Modal>,
    pub notice: Option<Notice>,
    pub active_task: Option<ActiveTask>,
    pub last_action_result: Option<ActionResultView>,
    pub last_preview: Option<(String, String)>,
    pub pending_requests: Vec<RefreshRequest>,
    pub effects: Vec<AppEffect>,
    provider_request_seq: u64,
    account_request_seq: u64,
    credit_request_seq: u64,
    usage_request_seq: u64,
    diagnostic_request_seq: u64,
    next_task_id: u64,
}

impl App {
    pub fn new(info: AppInfo) -> Self {
        let mut app = Self {
            info,
            page: Page::Overview,
            providers: Resource::default(),
            accounts: Resource::default(),
            credits: Resource::default(),
            usage: Resource::default(),
            usage_range: UsageRange::Week,
            usage_model_cursor: 0,
            provider_cursor: 0,
            account_cursor: 0,
            quota_cursor: 0,
            log_lines: Vec::new(),
            log_filter: String::new(),
            log_follow: true,
            log_match: None,
            log_scroll: 0,
            log_max_scroll: 0,
            log_view_height: 0,
            log_error: None,
            log_last_success: None,
            log_refreshing: false,
            log_request_id: 0,
            loaded_log_provider: None,
            log_lines_per_fetch: 160,
            diag: Resource::default(),
            diag_title: "尚未运行诊断".to_string(),
            diag_scroll: 0,
            modal: None,
            notice: None,
            active_task: None,
            last_action_result: None,
            last_preview: None,
            pending_requests: Vec::new(),
            effects: Vec::new(),
            provider_request_seq: 0,
            account_request_seq: 0,
            credit_request_seq: 0,
            usage_request_seq: 0,
            diagnostic_request_seq: 0,
            next_task_id: 1,
        };
        app.queue_provider_refresh();
        app.queue_account_refresh();
        app.queue_credit_refresh();
        app.queue_usage_refresh();
        app
    }

    pub fn account_data(&self) -> Option<&AccountSnapshot> {
        self.accounts.data.as_ref()
    }

    pub fn selected_usage_model(&self) -> Option<&ModelUsage> {
        let snapshot = self.usage.data.as_ref()?;
        snapshot.models.get(
            self.usage_model_cursor
                .min(snapshot.models.len().saturating_sub(1)),
        )
    }

    pub fn selected_provider(&self) -> Option<&Provider> {
        let data = self.providers.data.as_ref()?;
        data.providers.get(self.clamped_provider_cursor(data))
    }

    pub fn selected_provider_id(&self) -> Option<String> {
        self.selected_provider().map(|provider| provider.id.clone())
    }

    pub fn provider_count(&self) -> usize {
        self.providers
            .data
            .as_ref()
            .map_or(0, |snapshot| snapshot.providers.len())
    }

    fn clamped_provider_cursor(&self, data: &ProviderSnapshot) -> usize {
        self.provider_cursor
            .min(data.providers.len().saturating_sub(1))
    }

    pub fn selectable_account_count(&self) -> usize {
        self.account_data().map_or(0, |snapshot| {
            snapshot
                .providers
                .iter()
                .map(|group| group.accounts.len())
                .sum()
        })
    }

    pub fn selected_account(&self) -> Option<SelectedAccount<'_>> {
        let snapshot = self.account_data()?;
        account_at(self.account_cursor, snapshot)
    }

    pub fn quota_lines(&self) -> Vec<QuotaLine> {
        let Some(snapshot) = self.credits.data.as_ref() else {
            return Vec::new();
        };
        snapshot.rows.iter().flat_map(quota_lines_for_row).collect()
    }

    pub fn selected_quota(&self) -> Option<QuotaLine> {
        let lines = self.quota_lines();
        lines
            .get(self.quota_cursor.min(lines.len().saturating_sub(1)))
            .cloned()
    }

    pub fn visible_log_lines(&self) -> Vec<String> {
        if self.log_filter.is_empty() {
            return self.log_lines.clone();
        }
        let filter = self.log_filter.to_lowercase();
        self.log_lines
            .iter()
            .filter(|line| line.to_lowercase().contains(&filter))
            .cloned()
            .collect()
    }

    /// 过滤命中行的序号（相对过滤后的列表），供 n/N 跳转使用。
    pub fn log_match_count(&self) -> usize {
        if self.log_filter.is_empty() {
            return 0;
        }
        let filter = self.log_filter.to_lowercase();
        self.log_lines
            .iter()
            .filter(|line| line.to_lowercase().contains(&filter))
            .count()
    }

    fn jump_log_match(&mut self, forward: bool) {
        if self.log_filter.is_empty() {
            self.set_notice("先按 f 设置过滤条件，再用 n/N 跳转命中。", true);
            return;
        }
        if self.log_lines.is_empty() {
            self.set_notice("日志尚未加载完成，稍候再按 n/N。", true);
            return;
        }
        let count = self.log_match_count();
        if count == 0 {
            self.log_match = None;
            self.set_notice("当前过滤没有命中行。", true);
            return;
        }
        let next = match (self.log_match, forward) {
            (Some(current), true) => (current + 1) % count,
            (Some(current), false) => (current + count - 1) % count,
            (None, true) => 0,
            (None, false) => count - 1,
        };
        self.log_match = Some(next);
        // 跳到命中行：关闭跟随，把目标行放到视口顶部附近。
        self.log_follow = false;
        self.log_scroll = next.saturating_sub(2) as u16;
        self.set_notice(format!("过滤命中 {}/{}", next + 1, count), false);
    }

    pub fn queue_provider_refresh(&mut self) {
        if self.providers.refreshing {
            return;
        }
        self.queue_provider_refresh_force();
    }

    fn queue_provider_refresh_force(&mut self) {
        self.provider_request_seq += 1;
        let request_id = self.provider_request_seq;
        self.providers.begin(request_id);
        self.pending_requests
            .push(RefreshRequest::Providers(request_id));
    }

    pub fn queue_account_refresh(&mut self) {
        if self.accounts.refreshing {
            return;
        }
        self.queue_account_refresh_force();
    }

    fn queue_account_refresh_force(&mut self) {
        self.account_request_seq += 1;
        let request_id = self.account_request_seq;
        self.accounts.begin(request_id);
        self.pending_requests
            .push(RefreshRequest::Accounts(request_id));
    }

    pub fn queue_credit_refresh(&mut self) {
        if self.credits.refreshing {
            return;
        }
        self.queue_credit_refresh_force();
    }

    fn queue_credit_refresh_force(&mut self) {
        self.credit_request_seq += 1;
        let request_id = self.credit_request_seq;
        self.credits.begin(request_id);
        self.pending_requests
            .push(RefreshRequest::Credits(request_id));
    }

    pub fn queue_usage_refresh(&mut self) {
        if self.usage.refreshing {
            return;
        }
        self.queue_usage_refresh_force();
    }

    fn queue_usage_refresh_force(&mut self) {
        self.usage_request_seq += 1;
        let request_id = self.usage_request_seq;
        self.usage.begin(request_id);
        self.pending_requests
            .push(RefreshRequest::Usage(request_id));
    }

    pub fn cycle_usage_range(&mut self) {
        self.usage_range = self.usage_range.next();
        self.usage_model_cursor = 0;
        self.queue_usage_refresh_force();
    }

    pub fn queue_log_refresh(&mut self) {
        if self.log_refreshing {
            return;
        }
        let Some(provider_id) = self.selected_provider_id() else {
            return;
        };
        self.log_request_id += 1;
        let request_id = self.log_request_id;
        self.log_refreshing = true;
        self.log_error = None;
        self.pending_requests.push(RefreshRequest::Logs {
            request_id,
            provider_id: provider_id.clone(),
            lines: self.log_lines_per_fetch,
        });
        self.loaded_log_provider = Some(provider_id);
    }

    pub fn queue_doctor(&mut self) {
        if self.diag.refreshing {
            return;
        }
        self.diagnostic_request_seq += 1;
        let request_id = self.diagnostic_request_seq;
        self.diag.begin(request_id);
        self.diag_title = "router 自检".to_string();
        self.diag_scroll = 0;
        self.pending_requests
            .push(RefreshRequest::Doctor(request_id));
    }

    pub fn queue_health_no_probe(&mut self) {
        if self.diag.refreshing {
            return;
        }
        self.diagnostic_request_seq += 1;
        let request_id = self.diagnostic_request_seq;
        self.diag.begin(request_id);
        self.diag_title = "健康检查（不试打）".to_string();
        self.diag_scroll = 0;
        self.pending_requests.push(RefreshRequest::Health {
            request_id,
            provider_id: self.selected_provider_id(),
        });
    }

    pub fn refresh_current_page(&mut self) {
        match self.page {
            Page::Overview | Page::Providers | Page::Diagnostics => {
                self.queue_provider_refresh();
            }
            Page::Credits => {
                self.queue_provider_refresh();
                self.queue_credit_refresh();
            }
            Page::Usage => {
                self.queue_provider_refresh();
                self.queue_usage_refresh();
            }
            Page::Accounts => {
                self.queue_provider_refresh();
                self.queue_account_refresh();
            }
            Page::Logs => {
                if !self.log_follow {
                    self.log_follow = true;
                }
                self.queue_log_refresh();
            }
        }
    }

    pub fn switch_page(&mut self, page: Page) {
        if self.page == page {
            return;
        }
        self.page = page;
        match page {
            Page::Credits => self.queue_credit_refresh(),
            Page::Usage => self.queue_usage_refresh(),
            Page::Accounts => self.queue_account_refresh(),
            Page::Logs => {
                if self.loaded_log_provider != self.selected_provider_id() {
                    self.log_lines.clear();
                    self.log_last_success = None;
                    self.log_scroll = 0;
                }
                self.queue_log_refresh();
            }
            Page::Overview | Page::Providers | Page::Diagnostics => {}
        }
    }

    pub fn move_selection(&mut self, delta: i32) {
        match self.page {
            Page::Accounts => {
                let count = self.selectable_account_count();
                if count > 0 {
                    self.account_cursor = move_index(self.account_cursor, count, delta);
                }
            }
            Page::Credits => {
                let count = self.quota_lines().len();
                if count > 0 {
                    self.quota_cursor = move_index(self.quota_cursor, count, delta);
                }
            }
            Page::Usage => {
                if let Some(snapshot) = self.usage.data.as_ref() {
                    if !snapshot.models.is_empty() {
                        self.usage_model_cursor =
                            move_index(self.usage_model_cursor, snapshot.models.len(), delta);
                    }
                }
            }
            Page::Logs => {
                if delta < 0 && self.log_follow {
                    self.log_follow = false;
                    self.log_scroll = self.log_max_scroll;
                }
                if delta < 0 {
                    self.log_scroll = self.log_scroll.saturating_sub(delta.unsigned_abs() as u16);
                } else {
                    self.log_scroll = self
                        .log_scroll
                        .saturating_add(delta as u16)
                        .min(self.log_max_scroll);
                    if self.log_scroll >= self.log_max_scroll {
                        self.log_follow = true;
                    }
                }
            }
            Page::Diagnostics => {
                let amount = delta.unsigned_abs() as u16;
                if delta < 0 {
                    self.diag_scroll = self.diag_scroll.saturating_sub(amount);
                } else {
                    self.diag_scroll = self.diag_scroll.saturating_add(amount);
                }
            }
            Page::Overview | Page::Providers => {
                if let Some(data) = self.providers.data.as_ref() {
                    if !data.providers.is_empty() {
                        self.provider_cursor =
                            move_index(self.provider_cursor, data.providers.len(), delta);
                    }
                }
            }
        }
    }

    pub fn cycle_provider(&mut self, delta: i32) {
        let count = self.provider_count();
        if count == 0 {
            return;
        }
        let old = self.selected_provider_id();
        self.provider_cursor = move_index(self.provider_cursor, count, delta);
        let new = self.selected_provider_id();
        if old != new {
            self.on_provider_changed();
        }
    }

    fn on_provider_changed(&mut self) {
        self.log_lines.clear();
        self.log_filter.clear();
        self.log_match = None;
        self.log_scroll = 0;
        self.log_follow = true;
        self.log_last_success = None;
        self.log_max_scroll = 0;
        if self.page == Page::Logs {
            self.queue_log_refresh_force();
        }
    }

    pub fn handle_key(&mut self, key: KeyEvent) {
        if key.kind != KeyEventKind::Press {
            return;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char('c')) {
            self.request_quit();
            return;
        }
        if self.modal.is_some() {
            self.handle_modal_key(key);
            return;
        }
        if key.code == KeyCode::Char('q') {
            self.request_quit();
            return;
        }
        if key.code == KeyCode::Char('?') {
            self.modal = Some(Modal::Help);
            return;
        }
        // 页面内的数字键（额度 4 → 账号、账号 3 → 额度）必须先于全局翻页处理，
        // 否则永远只会切到同名页面，选中 provider 的联动就丢了。
        if let KeyCode::Char(character) = key.code {
            if self.handle_page_number_shortcut(character) {
                return;
            }
        }
        if let KeyCode::Char(character) = key.code {
            if let Some(page) = Page::from_number(character) {
                self.switch_page(page);
                return;
            }
        }
        if key.code == KeyCode::Char('r') {
            self.refresh_current_page();
            return;
        }
        if key.code == KeyCode::Char('O') {
            self.open_last_action_result();
            return;
        }
        if key.code == KeyCode::Char('j') || key.code == KeyCode::Down {
            self.move_selection(1);
            return;
        }
        if key.code == KeyCode::Char('k') || key.code == KeyCode::Up {
            self.move_selection(-1);
            return;
        }
        if key.code == KeyCode::PageDown {
            self.move_selection(10);
            return;
        }
        if key.code == KeyCode::PageUp {
            self.move_selection(-10);
            return;
        }

        match self.page {
            Page::Overview => self.handle_overview_key(key),
            Page::Providers => self.handle_provider_key(key),
            Page::Credits => self.handle_credit_key(key),
            Page::Accounts => self.handle_account_key(key),
            Page::Logs => self.handle_log_key(key),
            Page::Diagnostics => self.handle_diagnostic_key(key),
            Page::Usage => self.handle_usage_key(key),
        }
    }

    fn handle_overview_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Left | KeyCode::Char('h') => self.cycle_provider(-1),
            KeyCode::Right | KeyCode::Char('l') => self.cycle_provider(1),
            KeyCode::Enter => self.show_provider_detail(),
            _ => {}
        }
    }

    /// 处理「跳到另一页并带上当前选中 provider」的数字键。
    /// 返回 true 表示已消费该按键。
    fn handle_page_number_shortcut(&mut self, character: char) -> bool {
        match (self.page, character) {
            (Page::Credits, '4') => {
                if let Some(line) = self.selected_quota() {
                    self.select_provider_by_id(&line.provider);
                }
                self.switch_page(Page::Accounts);
                true
            }
            (Page::Accounts, '3') => {
                if let Some(selected) = self.selected_account() {
                    let provider_id = selected.group.id.clone();
                    self.select_provider_by_id(&provider_id);
                }
                self.switch_page(Page::Credits);
                true
            }
            _ => false,
        }
    }

    fn handle_provider_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Left | KeyCode::Char('h') => self.cycle_provider(-1),
            KeyCode::Right | KeyCode::Char('l') => self.cycle_provider(1),
            KeyCode::Enter => self.show_provider_detail(),
            KeyCode::Char('u') => self.action_on_selected(ActionKind::Start),
            KeyCode::Char('d') => self.action_on_selected(ActionKind::Stop),
            KeyCode::Char('K') => self.action_on_selected(ActionKind::StopKeepOpenCode),
            KeyCode::Char('R') => self.action_on_selected(ActionKind::Restart),
            KeyCode::Char('o') => self.action_on_selected(ActionKind::OnlyEnable),
            KeyCode::Char('x') => self.action_on_selected(ActionKind::Disable),
            KeyCode::Char('s') => self.confirm_action(Action::global(ActionKind::Sync)),
            KeyCode::Char('A') => self.confirm_action(Action::global(ActionKind::EnableAll)),
            KeyCode::Char('N') => self.confirm_action(Action::global(ActionKind::DisableAll)),
            KeyCode::Char('L') => {
                self.switch_page(Page::Logs);
                self.queue_log_refresh();
            }
            _ => {}
        }
    }

    fn handle_credit_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Left | KeyCode::Char('h') => self.cycle_provider(-1),
            KeyCode::Right | KeyCode::Char('l') => self.cycle_provider(1),
            KeyCode::Enter => self.show_quota_detail(),
            KeyCode::Char('c') => {
                self.set_notice(
                    "签到尚未接入统一 Node 契约；当前只展示可领取状态，不执行真实领取。",
                    true,
                );
            }
            _ => {}
        }
    }

    fn handle_account_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Enter => self.show_account_detail(),
            KeyCode::Char('v') => self.preview_selected_account(),
            KeyCode::Char('c') => self.confirm_selected_account_switch(),
            KeyCode::Char('a') => self.confirm_enable_all_accounts(),
            KeyCode::Char('A') => self.interactive_for_selected(ActionKind::AddAccount),
            KeyCode::Char('L') => self.interactive_for_selected(ActionKind::Login),
            KeyCode::Left | KeyCode::Char('h') => self.move_selection(-1),
            KeyCode::Right | KeyCode::Char('l') => self.move_selection(1),
            _ => {}
        }
    }

    fn handle_log_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Left | KeyCode::Char('h') => self.cycle_provider(-1),
            KeyCode::Right | KeyCode::Char('l') => self.cycle_provider(1),
            KeyCode::Char('p') => {
                self.log_follow = !self.log_follow;
                if self.log_follow {
                    self.log_scroll = self.log_max_scroll;
                    self.log_match = None;
                }
            }
            KeyCode::Char('f') | KeyCode::Char('/') => {
                self.modal = Some(Modal::Input(InputDialog {
                    title: "日志过滤（只作用于当前已加载内容）".into(),
                    value: self.log_filter.clone(),
                    purpose: InputPurpose::LogFilter,
                }));
            }
            KeyCode::Char('n') => self.jump_log_match(true),
            KeyCode::Char('N') => self.jump_log_match(false),
            KeyCode::Char('+') | KeyCode::Char('=') => {
                self.log_lines_per_fetch = self.log_lines_per_fetch.saturating_add(80).min(2000);
                self.log_lines.clear();
                self.queue_log_refresh_force();
            }
            KeyCode::Char('-') => {
                self.log_lines_per_fetch = self.log_lines_per_fetch.saturating_sub(80).max(40);
                self.log_lines.clear();
                self.queue_log_refresh_force();
            }
            KeyCode::Char('c') => {
                self.log_lines.clear();
                self.log_scroll = 0;
                self.log_match = None;
                self.set_notice("已清除内存中的日志视图；磁盘日志未删除。", false);
            }
            KeyCode::End => {
                self.log_follow = true;
                self.log_scroll = self.log_max_scroll;
                self.log_match = None;
                self.queue_log_refresh();
            }
            KeyCode::Home => {
                self.log_follow = false;
                self.log_scroll = 0;
            }
            _ => {}
        }
    }

    fn queue_log_refresh_force(&mut self) {
        self.log_refreshing = false;
        self.queue_log_refresh();
    }

    fn handle_diagnostic_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Left => self.cycle_provider(-1),
            KeyCode::Right | KeyCode::Char('l') => self.cycle_provider(1),
            KeyCode::Char('d') => self.queue_doctor(),
            KeyCode::Char('h') => self.queue_health_no_probe(),
            KeyCode::Char('P') => self.action_on_selected(ActionKind::Probe),
            KeyCode::Char('5') => self.switch_page(Page::Logs),
            _ => {}
        }
    }

    fn handle_usage_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Enter => self.show_usage_detail(),
            KeyCode::Char('t') | KeyCode::Char('[') | KeyCode::Char(']') => {
                self.cycle_usage_range()
            }
            KeyCode::Left | KeyCode::Char('h') => self.move_selection(-1),
            KeyCode::Right | KeyCode::Char('l') => self.move_selection(1),
            _ => {}
        }
    }

    fn show_usage_detail(&mut self) {
        let Some(model) = self.selected_usage_model() else {
            self.set_notice("当前没有可查看的模型用量。", true);
            return;
        };
        let text = format!(
            "模型：{}\nProvider：{}\nVariant：{}\n步骤：{}\n\nToken 构成\n输入：{}\n输出：{}\n推理：{}\n缓存读取：{}\n缓存写入：{}\n\nOpenCode 报告成本：${:.4}\n\n说明：steps 是 OpenCode 会话步骤，不等同于 HTTP 请求数；Token 与成本均来自 OpenCode 统计。",
            model.model.id,
            model.model.provider_id,
            model.model.variant,
            model.steps,
            model.tokens.input,
            model.tokens.output,
            model.tokens.reasoning,
            model.tokens.cache.read,
            model.tokens.cache.write,
            model.cost
        );
        self.modal = Some(Modal::Detail {
            title: format!("{} 用量详情", model.model.id),
            text,
            scroll: 0,
        });
    }

    fn handle_modal_key(&mut self, key: KeyEvent) {
        match self.modal.as_ref() {
            Some(Modal::Confirm(_)) => match key.code {
                KeyCode::Esc => self.modal = None,
                KeyCode::Left | KeyCode::Right | KeyCode::Tab => {
                    if let Some(Modal::Confirm(dialog)) = self.modal.as_mut() {
                        dialog.confirm_focused = !dialog.confirm_focused;
                    }
                }
                KeyCode::Enter => {
                    if let Some(Modal::Confirm(dialog)) = self.modal.take() {
                        if dialog.confirm_focused {
                            self.start_confirmed_action(dialog.action);
                        }
                    }
                }
                _ => {}
            },
            Some(Modal::Help) => {
                if matches!(
                    key.code,
                    KeyCode::Esc | KeyCode::Char('q') | KeyCode::Char('?')
                ) {
                    self.modal = None;
                }
            }
            Some(Modal::Detail { .. }) => match key.code {
                KeyCode::Esc | KeyCode::Char('q') | KeyCode::Enter => self.modal = None,
                KeyCode::Char('j') | KeyCode::Down => {
                    if let Some(Modal::Detail { scroll, .. }) = self.modal.as_mut() {
                        *scroll = scroll.saturating_add(1);
                    }
                }
                KeyCode::Char('k') | KeyCode::Up => {
                    if let Some(Modal::Detail { scroll, .. }) = self.modal.as_mut() {
                        *scroll = scroll.saturating_sub(1);
                    }
                }
                KeyCode::PageDown => {
                    if let Some(Modal::Detail { scroll, .. }) = self.modal.as_mut() {
                        *scroll = scroll.saturating_add(10);
                    }
                }
                KeyCode::PageUp => {
                    if let Some(Modal::Detail { scroll, .. }) = self.modal.as_mut() {
                        *scroll = scroll.saturating_sub(10);
                    }
                }
                _ => {}
            },
            Some(Modal::Input(_)) => match key.code {
                KeyCode::Esc => self.modal = None,
                KeyCode::Enter => {
                    if let Some(Modal::Input(dialog)) = self.modal.take() {
                        match dialog.purpose {
                            InputPurpose::LogFilter => {
                                self.log_filter = dialog.value;
                                self.log_scroll = 0;
                                self.log_follow = true;
                                self.log_match = None;
                            }
                        }
                    }
                }
                KeyCode::Backspace => {
                    if let Some(Modal::Input(dialog)) = self.modal.as_mut() {
                        dialog.value.pop();
                    }
                }
                KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    if let Some(Modal::Input(dialog)) = self.modal.as_mut() {
                        dialog.value.clear();
                    }
                }
                KeyCode::Char(character)
                    if !key.modifiers.contains(KeyModifiers::CONTROL)
                        && !character.is_control() =>
                {
                    if let Some(Modal::Input(dialog)) = self.modal.as_mut() {
                        if dialog.value.chars().count() < 120 {
                            dialog.value.push(character);
                        }
                    }
                }
                _ => {}
            },
            None => {}
        }
    }

    fn action_on_selected(&mut self, kind: ActionKind) {
        if let Some(provider) = self.selected_provider() {
            let action = Action::one(kind, provider.id.clone());
            self.confirm_action(action);
        } else {
            self.set_notice("当前没有选中 provider。", true);
        }
    }

    fn interactive_for_selected(&mut self, kind: ActionKind) {
        if let Some(provider) = self.selected_provider() {
            self.confirm_action(Action::one(kind, provider.id.clone()));
        } else if let Some(selected) = self.selected_account() {
            self.confirm_action(Action::one(kind, selected.group.id.clone()));
        } else {
            self.set_notice("当前没有选中 provider。", true);
        }
    }

    fn confirm_action(&mut self, action: Action) {
        if let Some(reason) = self.blocked_reason(&action) {
            self.set_notice(reason, true);
            return;
        }
        let body = self.action_description(&action);
        self.modal = Some(Modal::Confirm(ConfirmDialog {
            title: format!("确认{}？", action.title()),
            action,
            body,
            confirm_focused: false,
        }));
    }

    fn blocked_reason(&self, action: &Action) -> Option<&'static str> {
        if self.info.read_only
            && (action.is_write() || matches!(action.kind, ActionKind::Probe | ActionKind::Checkin))
        {
            Some("当前为只读模式；写操作和消耗型操作已禁用。")
        } else if action.kind == ActionKind::Checkin {
            Some("签到尚未接入统一的 Node 命令，当前不会执行真实领取。")
        } else if matches!(action.kind, ActionKind::OnlyEnable | ActionKind::Disable)
            && self.targets_gateway(action)
        {
            // 网关是叠加层：`on gateway` 会顺手把其它八家全关掉，`off gateway`
            // 又不反映到它的开关列。它的启停语义在 gateway 子命令里。
            Some("网关不参与开关语义；请用 `node router.mjs gateway up/down` 启停。")
        } else if matches!(action.kind, ActionKind::Login | ActionKind::AddAccount)
            && self.targets_gateway(action)
        {
            // 网关自己没有凭证，登录它只会得到一条「不知道怎么登录」。
            Some("网关没有自己的账号；请对具体 provider 登录。")
        } else {
            None
        }
    }

    fn targets_gateway(&self, action: &Action) -> bool {
        action
            .provider_ids
            .iter()
            .any(|id| id == crate::domain::GATEWAY_PROVIDER_ID)
    }

    fn action_description(&self, action: &Action) -> String {
        let provider = action
            .provider_ids
            .first()
            .and_then(|id| self.providers.data.as_ref()?.provider(id))
            .map(|provider| format!("{}（{}）", provider.title, provider.id))
            .unwrap_or_else(|| "全部 provider".to_string());

        let effect = match action.kind {
            ActionKind::Start => {
                "启动该反代，不改变启用开关；会同步相关客户端配置。缺少凭证时不会自动打开浏览器。"
            }
            ActionKind::Stop => "停止该反代，并从 opencode 中移除对应 provider；启用开关保持不变。",
            ActionKind::StopKeepOpenCode => {
                "只停止该反代进程；opencode provider 将保留，客户端可能暂时指向不可用端点。"
            }
            ActionKind::Restart => "停止并重新启动该反代，随后同步客户端配置。",
            ActionKind::OnlyEnable => {
                "这是排他操作：目标 provider 将启用，其他已启用的 provider 将被关闭。"
            }
            ActionKind::Disable => "关闭该 provider、停止进程并同步移除客户端 provider。",
            ActionKind::EnableAll => "启用并启动全部 provider，增加内存和端口占用。",
            ActionKind::DisableAll => {
                "停止全部 provider，清空启用选择，并同步移除客户端 provider。"
            }
            ActionKind::Sync => "按当前启用集合同步 opencode 配置；不改变 provider 进程。",
            ActionKind::SwitchAccountPreview => "只预览账号切换结果，不写凭证、不重启反代。",
            ActionKind::SwitchAccount => "切换生效账号，可能写入账号池并重启正在运行的反代。",
            ActionKind::EnableAllAccounts => {
                "恢复该 provider 全部账号参与轮询，可能从单账号切换为多账号并重启。"
            }
            ActionKind::Login => {
                "暂时离开全屏界面运行交互式登录；可能打开浏览器、要求 PAT 或重启反代。"
            }
            ActionKind::AddAccount => {
                "暂时离开全屏界面添加账号；浏览器与凭证输入由现有 Node 工具处理。"
            }
            ActionKind::Probe => {
                "会发送真实模型请求，可能消耗积分、排队或等待较长时间。默认只测试当前 provider。"
            }
            ActionKind::Checkin => "会执行真实签到请求并可能改变账号额度。",
        };

        let mut body = format!(
            "目标：{provider}\n影响：{effect}\n\n{}",
            action.command_preview()
        );
        if action.kind == ActionKind::OnlyEnable {
            let other_enabled: Vec<String> = self
                .providers
                .data
                .as_ref()
                .map(|snapshot| {
                    snapshot
                        .providers
                        .iter()
                        .filter(|provider| {
                            provider.on && !action.provider_ids.iter().any(|id| id == &provider.id)
                        })
                        .map(|provider| format!("{}（{}）", provider.title, provider.id))
                        .collect()
                })
                .unwrap_or_default();
            if other_enabled.is_empty() {
                body.push_str("\n\n当前没有其他已启用 provider。");
            } else {
                body.push_str("\n\n将关闭：");
                body.push_str(&other_enabled.join("、"));
            }
        }
        if action.kind == ActionKind::EnableAll {
            body.push_str(&format!(
                "\n将影响：{} 个 provider。",
                self.provider_count()
            ));
        }
        if action.kind == ActionKind::DisableAll {
            body.push_str(&format!(
                "\n将影响：{} 个 provider。",
                self.provider_count()
            ));
        }
        if action.risk() == ActionRisk::High {
            body.insert_str(0, "高风险操作\n\n");
        }
        body
    }

    fn start_confirmed_action(&mut self, action: Action) {
        if let Some(reason) = self.blocked_reason(&action) {
            self.set_notice(reason, true);
            return;
        }
        if self.active_task.is_some() {
            self.set_notice("已有写任务在运行，请等待完成。", true);
            return;
        }
        let task_id = self.next_task_id;
        self.next_task_id += 1;
        self.active_task = Some(ActiveTask {
            id: task_id,
            action: action.clone(),
            started: Instant::now(),
        });
        self.modal = None;
        if action.is_interactive() {
            self.effects
                .push(AppEffect::RunInteractive { task_id, action });
        } else {
            self.effects.push(AppEffect::RunAction { task_id, action });
        }
    }

    fn preview_selected_account(&mut self) {
        let Some(selected) = self.selected_account() else {
            self.set_notice("当前没有选中账号。", true);
            return;
        };
        if !selected.group.switchable {
            self.set_notice("该 provider 是单账号，换号请使用登录。", true);
            return;
        }
        let action = Action::account(
            ActionKind::SwitchAccountPreview,
            selected.group.id.clone(),
            selected.account.key.clone(),
        );
        self.confirm_action(action);
    }

    fn confirm_selected_account_switch(&mut self) {
        let Some(selected) = self.selected_account() else {
            self.set_notice("当前没有选中账号。", true);
            return;
        };
        if !selected.group.switchable {
            self.set_notice("该 provider 是单账号，换号请使用登录。", true);
            return;
        }
        let expected = (selected.group.id.clone(), selected.account.key.clone());
        if self.last_preview.as_ref() != Some(&expected) {
            self.set_notice("请先按 v 预览切换结果，再确认正式切换。", true);
            return;
        }
        self.confirm_action(Action::account(
            ActionKind::SwitchAccount,
            expected.0,
            expected.1,
        ));
    }

    fn confirm_enable_all_accounts(&mut self) {
        let Some(selected) = self.selected_account() else {
            self.set_notice("当前没有选中账号。", true);
            return;
        };
        if !selected.group.switchable {
            self.set_notice("该 provider 是单账号，不支持恢复账号池。", true);
            return;
        }
        self.confirm_action(Action::one(
            ActionKind::EnableAllAccounts,
            selected.group.id.clone(),
        ));
    }

    fn show_provider_detail(&mut self) {
        let Some(provider) = self.selected_provider() else {
            return;
        };
        let detail = format!(
            "provider：{}\nID：{}\n端口：{}\n启用开关：{}\n进程：{}\nPID：{}\n模型数：{}\n控制方式：{}\nopencode：{}\n用户自管配置：{}\n认证状态：{}\n认证说明：{}\n凭证到期：{}\n\n状态组合：{}\n\n按 Esc 返回。",
            provider.title,
            provider.id,
            provider.port,
            provider.switch_label(),
            if provider.up { "运行中" } else { "已停止" },
            provider
                .pids
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(", ")
                .if_empty("—"),
            provider
                .models
                .map(|models| models.to_string())
                .unwrap_or_else(|| "—".into()),
            provider.control.clone().if_empty("—"),
            provider.client_label(),
            yes_no(provider.oc_user_owned),
            provider.auth.effective_state().label(),
            provider.auth.display_label(),
            provider
                .auth
                .expires_at
                .as_ref()
                .map(ToString::to_string)
                .unwrap_or_else(|| "—".into()),
            drift_description(provider),
        );
        self.modal = Some(Modal::Detail {
            title: format!("{} 详情", provider.title),
            text: detail,
            scroll: 0,
        });
    }

    fn show_account_detail(&mut self) {
        let Some(selected) = self.selected_account() else {
            return;
        };
        let health = selected
            .account
            .health
            .summary()
            .unwrap_or_else(|| "无异常".to_string());
        let text = format!(
            "provider：{}（{}）\n来源类型：{}\n账号 key：{}\n名称：{}\nUID：{}\n参与轮询：{}\n当前生效：{}\n可切换：{}\n健康检查：{}\n说明：{}\n\n按 Esc 返回。",
            selected.group.title,
            selected.group.id,
            selected.group.kind.clone().if_empty("—"),
            selected.account.key,
            selected.account.name.clone().if_empty("—"),
            selected.account.uid.as_deref().unwrap_or("—"),
            yes_no(selected.account.enabled),
            yes_no(selected.account.active),
            yes_no(selected.group.switchable),
            health,
            selected.account.detail.as_deref().unwrap_or("—"),
        );
        self.modal = Some(Modal::Detail {
            title: "账号详情".into(),
            text,
            scroll: 0,
        });
    }

    fn show_quota_detail(&mut self) {
        let Some(line) = self.selected_quota() else {
            return;
        };
        let text = format!(
            "provider：{}（{}）\n来源/账号：{}\n剩余：{}\n总量：{}\n单位：{}\n状态：{}\n数据时间：{}\n\n{}",
            line.title,
            line.provider,
            line.source,
            line.remaining
                .map(crate::domain::format_number)
                .unwrap_or_else(|| "—".into()),
            line.total
                .map(crate::domain::format_number)
                .unwrap_or_else(|| "—".into()),
            line.unit.if_empty("—"),
            line.status,
            line.fetched_at.as_deref().unwrap_or("—"),
            line.detail,
        );
        self.modal = Some(Modal::Detail {
            title: format!("{} 额度详情", line.title),
            text,
            scroll: 0,
        });
    }

    fn select_provider_by_id(&mut self, provider_id: &str) {
        if let Some(data) = self.providers.data.as_ref() {
            if let Some(index) = data
                .providers
                .iter()
                .position(|provider| provider.id == provider_id)
            {
                self.provider_cursor = index;
            }
        }
    }

    fn open_last_action_result(&mut self) {
        if let Some(result) = &self.last_action_result {
            self.modal = Some(Modal::Detail {
                title: result.title.clone(),
                text: result.result.text.clone(),
                scroll: 0,
            });
        } else {
            self.set_notice("还没有可查看的操作输出。", false);
        }
    }

    pub fn request_quit(&mut self) {
        if self.active_task.is_some() {
            self.set_notice(
                "写任务仍在执行；请等待完成后再退出，避免中断配置写入。",
                true,
            );
            return;
        }
        self.effects.push(AppEffect::Quit);
    }

    pub fn set_notice(&mut self, text: impl Into<String>, error: bool) {
        self.notice = Some(Notice {
            text: text.into(),
            error,
            created: Instant::now(),
        });
    }

    pub fn expire_notice(&mut self) {
        if self.notice.as_ref().is_some_and(|notice| {
            notice.created.elapsed() > NOTICE_TTL && self.active_task.is_none()
        }) {
            self.notice = None;
        }
    }

    pub fn handle_message(&mut self, message: AppMessage) {
        match message {
            AppMessage::Providers { request_id, result } => {
                if request_id != self.providers.request_id {
                    return;
                }
                match result {
                    Ok(snapshot) => {
                        let count = snapshot.providers.len();
                        let warnings = snapshot.warnings.clone();
                        self.providers.succeed(snapshot);
                        if count > 0 {
                            self.provider_cursor = self.provider_cursor.min(count - 1);
                        } else {
                            self.provider_cursor = 0;
                        }
                        self.account_cursor = self
                            .account_cursor
                            .min(self.selectable_account_count().saturating_sub(1));
                        let quota_count = self.quota_lines().len();
                        self.quota_cursor = self.quota_cursor.min(quota_count.saturating_sub(1));
                        if !warnings.is_empty() {
                            self.set_notice(
                                format!("状态已更新，但有 {} 条局部告警；按 O 查看最近操作输出，或刷新后重试。", warnings.len()),
                                false,
                            );
                        }
                        if self.page == Page::Logs && self.log_lines.is_empty() {
                            self.queue_log_refresh();
                        }
                    }
                    Err(error) => {
                        let message = safe_backend_error(error);
                        self.providers.fail(message.clone());
                        self.set_notice(format!("状态刷新失败：{message}"), true);
                    }
                }
            }
            AppMessage::Accounts { request_id, result } => {
                if request_id != self.accounts.request_id {
                    return;
                }
                match result {
                    Ok(snapshot) => {
                        let warnings = snapshot.warnings.clone();
                        self.accounts.succeed(snapshot);
                        let count = self.selectable_account_count();
                        self.account_cursor = self.account_cursor.min(count.saturating_sub(1));
                        if !warnings.is_empty() {
                            self.set_notice(
                                format!("账号已更新，但有 {} 条局部告警。", warnings.len()),
                                false,
                            );
                        }
                    }
                    Err(error) => {
                        let message = safe_backend_error(error);
                        self.accounts.fail(message.clone());
                        self.set_notice(format!("账号刷新失败：{message}"), true);
                    }
                }
            }
            AppMessage::Credits { request_id, result } => {
                if request_id != self.credits.request_id {
                    return;
                }
                match result {
                    Ok(snapshot) => {
                        let count = snapshot.rows.len();
                        let warnings = snapshot.warnings.clone();
                        self.credits.succeed(snapshot);
                        self.quota_cursor = self.quota_cursor.min(count.saturating_sub(1));
                        if !warnings.is_empty() {
                            self.set_notice(
                                format!("额度已更新，但有 {} 条来源告警。", warnings.len()),
                                false,
                            );
                        }
                    }
                    Err(error) => {
                        let message = safe_backend_error(error);
                        self.credits.fail(message.clone());
                        self.set_notice(format!("额度刷新失败：{message}"), true);
                    }
                }
            }
            AppMessage::Usage { request_id, result } => {
                if request_id != self.usage.request_id {
                    return;
                }
                match result {
                    Ok(snapshot) => {
                        let count = snapshot.models.len();
                        let warnings = snapshot.warnings.clone();
                        self.usage.succeed(snapshot);
                        self.usage_model_cursor =
                            self.usage_model_cursor.min(count.saturating_sub(1));
                        if !warnings.is_empty() {
                            self.set_notice(
                                format!("用量已更新，但有 {} 条来源告警。", warnings.len()),
                                false,
                            );
                        }
                    }
                    Err(error) => {
                        let message = safe_backend_error(error);
                        self.usage.fail(message.clone());
                        self.set_notice(format!("OpenCode 用量刷新失败：{message}"), true);
                    }
                }
            }
            AppMessage::Logs {
                request_id,
                provider_id,
                result,
            } => {
                if request_id != self.log_request_id {
                    return;
                }
                if self.selected_provider_id().as_deref() != Some(provider_id.as_str()) {
                    self.log_refreshing = false;
                    if self.page == Page::Logs && self.log_follow {
                        self.queue_log_refresh();
                    }
                    return;
                }
                self.log_refreshing = false;
                match result {
                    Ok(text) => {
                        let safe = sanitize_lines(&text.text, 2500);
                        self.log_lines =
                            safe.text.lines().map(ToOwned::to_owned).collect::<Vec<_>>();
                        self.log_last_success = Some(Instant::now());
                        self.log_error = if text.exit_code != Some(0) {
                            Some("日志命令返回非零退出码；内容可能不完整。".into())
                        } else {
                            None
                        };
                        if text.truncated || safe.truncated {
                            self.log_error = Some("日志仅显示最近内容（已截断）。".into());
                        }
                        // 新内容可能让命中数变少；把 n/N 的落点夹回有效范围，
                        // 否则标题会显示「第 5/2 处」这种不存在的序号。
                        let matches = self.log_match_count();
                        self.log_match = match (self.log_match, matches) {
                            (Some(_), 0) => None,
                            (Some(index), count) => Some(index.min(count - 1)),
                            (None, _) => None,
                        };
                        if self.log_follow {
                            self.log_scroll = self.log_max_scroll;
                        }
                    }
                    Err(error) => {
                        self.log_error = Some(safe_backend_error(error));
                    }
                }
            }
            AppMessage::Diagnostics {
                request_id,
                title,
                result,
            } => {
                if request_id != self.diag.request_id {
                    return;
                }
                self.diag_title = title;
                match result {
                    Ok(text) => {
                        self.diag.succeed(text);
                        self.diag_scroll = 0;
                    }
                    Err(error) => {
                        let message = safe_backend_error(error);
                        self.diag.fail(message.clone());
                        self.set_notice(format!("诊断失败：{message}"), true);
                    }
                }
            }
            AppMessage::ActionDone { task_id, result } => self.finish_action(task_id, result),
            AppMessage::Interrupt => self.request_quit(),
        }
    }

    pub fn finish_interactive_action(&mut self, task_id: u64, result: BackendResult<TextResult>) {
        self.finish_action(task_id, result);
    }

    fn finish_action(&mut self, task_id: u64, result: BackendResult<TextResult>) {
        let Some(task) = self.active_task.take() else {
            return;
        };
        if task.id != task_id {
            self.active_task = Some(task);
            return;
        }
        let action = task.action;
        let (result, label) = match result {
            Ok(result) => {
                if result.succeeded() {
                    self.set_notice(
                        format!("{}命令完成，正在刷新真实状态。", action.title()),
                        false,
                    );
                } else {
                    self.set_notice(
                        format!(
                            "{}命令返回非零退出码（{}）。按 O 查看输出。",
                            action.title(),
                            result
                                .exit_code
                                .map(|code| code.to_string())
                                .unwrap_or_else(|| "unknown".into())
                        ),
                        true,
                    );
                }
                (result, format!("{} 操作输出", action.title()))
            }
            Err(error) => {
                let message = safe_backend_error(error);
                self.set_notice(
                    format!("{}未能执行：{message}。按 O 查看详情。", action.title()),
                    true,
                );
                (
                    TextResult {
                        text: message,
                        exit_code: None,
                        truncated: false,
                    },
                    format!("{} 错误", action.title()),
                )
            }
        };

        if action.kind == ActionKind::SwitchAccountPreview && result.succeeded() {
            if let (Some(provider), Some(account)) = (
                action.provider_ids.first().cloned(),
                action.account_key.clone(),
            ) {
                self.last_preview = Some((provider, account));
            }
        }

        if action.kind == ActionKind::Probe && result.succeeded() {
            self.diag.succeed(result.clone());
            self.diag_title = format!("{} 真实试打", action.title());
            self.diag_scroll = 0;
        }

        self.last_action_result = Some(ActionResultView {
            title: label.clone(),
            result: result.clone(),
        });
        if !result.succeeded() {
            self.modal = Some(Modal::Detail {
                title: label,
                text: result.text,
                scroll: 0,
            });
        }

        let targets = action.refresh_targets();
        if targets.providers {
            self.queue_provider_refresh_force();
        }
        if targets.accounts {
            self.queue_account_refresh_force();
        }
        if targets.credits {
            self.queue_credit_refresh_force();
        }
    }
}

fn account_at<'a>(index: usize, snapshot: &'a AccountSnapshot) -> Option<SelectedAccount<'a>> {
    let mut current = 0;
    for group in &snapshot.providers {
        if index < current + group.accounts.len() {
            return group
                .accounts
                .get(index - current)
                .map(|account| SelectedAccount { group, account });
        }
        current += group.accounts.len();
    }
    None
}

fn move_index(current: usize, count: usize, delta: i32) -> usize {
    if count == 0 {
        return 0;
    }
    let current = current.min(count - 1) as i32;
    (current + delta).rem_euclid(count as i32) as usize
}

fn safe_backend_error(error: BackendError) -> String {
    sanitize_lines(&error.message, 12).text.trim().to_string()
}

fn yes_no(value: bool) -> &'static str {
    if value {
        "是"
    } else {
        "否"
    }
}

fn drift_description(provider: &Provider) -> String {
    if provider.overlay() {
        return "网关是叠加层：不参与开关，用 `router gateway up/down` 启停。".into();
    }
    if !provider.drift() {
        return "开关、进程和客户端配置一致。".into();
    }
    let mut parts = Vec::new();
    if provider.on != provider.up {
        parts.push(if provider.on {
            "已启用但进程未运行"
        } else {
            "已停用但进程仍在运行"
        });
    }
    if provider.on != provider.oc && !provider.oc_user_owned {
        parts.push(if provider.oc {
            "开关关闭但客户端仍有 provider"
        } else {
            "开关开启但客户端未写入"
        });
    }
    parts.join("；")
}

fn quota_lines_for_row(row: &QuotaRow) -> Vec<QuotaLine> {
    let fetched_at = row.fetched_at.clone();
    if !row.available {
        return vec![QuotaLine {
            provider: row.provider.clone(),
            title: row.title.clone(),
            source: row.account.clone().unwrap_or_else(|| "来源".into()),
            remaining: None,
            total: None,
            unit: String::new(),
            status: row.status_summary(),
            fetched_at,
            detail: format!(
                "来源类型：{}\n{}",
                row.kind.clone().if_empty("—"),
                row.detail
                    .iter()
                    .cloned()
                    .chain(row.reason.iter().cloned())
                    .collect::<Vec<_>>()
                    .join("\n")
                    .if_empty("来源不可用；界面不会把它显示为 0。")
            ),
        }];
    }

    if !row.accounts.is_empty() {
        return row
            .accounts
            .iter()
            .map(|account| {
                let mut flags: Vec<String> = Vec::new();
                if account.disabled {
                    flags.push("已停用".into());
                }
                if account.cooling {
                    flags.push("冷却中".into());
                }
                if account.quota_exhausted {
                    flags.push("额度已耗尽".into());
                }
                if let Some(error) = &account.error {
                    flags.push(error.clone());
                }
                if let Some(checkin) = &account.checkin {
                    // 不支持签到的来源不要往每行塞「不支持签到」，那只是噪音。
                    if checkin.supported {
                        // 停用账号标「可领取」会让人以为现在就能领到，实际它不参与调度。
                        if account.disabled && checkin.is_claimable() {
                            flags.push("未签到".to_string());
                        } else {
                            flags.push(checkin.summary());
                        }
                    }
                }
                if let Some(expiring) = account.expiring.filter(|value| *value > 0.0) {
                    flags.push(format!(
                        "即将过期 {} {}",
                        crate::domain::format_number(expiring),
                        account.unit
                    ));
                }
                QuotaLine {
                    provider: row.provider.clone(),
                    title: row.title.clone(),
                    source: account.name.clone().if_empty("账号"),
                    remaining: account.remaining,
                    total: account.total,
                    unit: account.unit.clone(),
                    status: if flags.is_empty() {
                        "正常".into()
                    } else {
                        flags.join(" · ")
                    },
                    fetched_at: fetched_at.clone(),
                    detail: format!(
                        "来源类型：{}\n共享来源状态：{}\n重置日：{}\n权益包：{}",
                        row.kind.clone().if_empty("—"),
                        row.status_summary(),
                        account.reset_date.as_deref().unwrap_or("—"),
                        account
                            .packs
                            .map(|packs| packs.to_string())
                            .unwrap_or_else(|| "—".into())
                    ),
                }
            })
            .collect();
    }

    if !row.buckets.is_empty() {
        return row
            .buckets
            .iter()
            .map(|bucket| QuotaLine {
                provider: row.provider.clone(),
                title: row.title.clone(),
                source: bucket.label.clone().if_empty("额度桶"),
                remaining: bucket.remaining,
                total: bucket.total,
                unit: bucket.unit.clone(),
                status: if row.kind == "workbuddy" {
                    if row.service_running == Some(false) {
                        "服务未运行".to_string()
                    } else {
                        bucket
                            .expires_at
                            .as_ref()
                            .and_then(crate::domain::format_expiry_at)
                            .map(|date| {
                                format!("有效至 {}", date.chars().take(10).collect::<String>())
                            })
                            .unwrap_or_else(|| "凭证可读".to_string())
                    }
                } else if row.quota_exhausted {
                    "额度已耗尽".to_string()
                } else {
                    bucket
                        .expiring
                        .filter(|value| *value > 0.0)
                        .map(|value| {
                            format!(
                                "即将过期 {} {}",
                                crate::domain::format_number(value),
                                bucket.unit
                            )
                        })
                        .unwrap_or_else(|| "正常".to_string())
                },
                fetched_at: fetched_at.clone(),
                detail: format!(
                    "来源类型：{}\n额度桶 ID：{}\n账号：{}\n已用：{}\n重置日：{}\n绝对到期：{}{}",
                    row.kind.clone().if_empty("—"),
                    bucket.id.clone().if_empty("—"),
                    row.account.as_deref().unwrap_or("—"),
                    bucket
                        .used
                        .map(crate::domain::format_number)
                        .unwrap_or_else(|| "—".into()),
                    bucket.reset_date.as_deref().unwrap_or("—"),
                    bucket
                        .expires_at
                        .as_ref()
                        .and_then(crate::domain::format_expiry_at)
                        .unwrap_or_else(|| "—".into()),
                    if row.detail.is_empty() {
                        String::new()
                    } else {
                        format!("\n说明：{}", row.detail.join(" · "))
                    }
                ),
            })
            .collect();
    }

    vec![QuotaLine {
        provider: row.provider.clone(),
        title: row.title.clone(),
        source: row.account.clone().unwrap_or_else(|| "来源".into()),
        remaining: None,
        total: None,
        unit: String::new(),
        status: row.status_summary(),
        fetched_at,
        detail: format!(
            "来源类型：{}\n{}",
            row.kind.clone().if_empty("—"),
            row.detail.join("\n")
        ),
    }]
}

trait StringExt {
    fn if_empty(self, fallback: &'static str) -> String;
}

impl StringExt for String {
    fn if_empty(self, fallback: &'static str) -> String {
        if self.trim().is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

#[cfg(test)]
mod tests {
    use futures_util::FutureExt;

    use super::*;
    use crossterm::event::KeyModifiers;

    fn app() -> App {
        let mut app = App::new(AppInfo {
            backend_label: "DEMO",
            root: "demo".into(),
            node: "demo".into(),
            demo: true,
            read_only: false,
            ascii: false,
            no_color: true,
            appearance: Appearance::Dark,
            refresh_secs: 5,
        });
        let fixture = crate::backend::fixture::FixtureBackend::new(false);
        let providers = fixture
            .providers()
            .now_or_never()
            .expect("fixture providers resolve immediately")
            .expect("fixture providers");
        app.handle_message(AppMessage::Providers {
            request_id: app.providers.request_id,
            result: Ok(providers),
        });
        let accounts = fixture
            .accounts()
            .now_or_never()
            .expect("fixture accounts resolve immediately")
            .expect("fixture accounts");
        app.handle_message(AppMessage::Accounts {
            request_id: app.accounts.request_id,
            result: Ok(accounts),
        });
        let credits = fixture
            .credits()
            .now_or_never()
            .expect("fixture credits resolve immediately")
            .expect("fixture credits");
        app.handle_message(AppMessage::Credits {
            request_id: app.credits.request_id,
            result: Ok(credits),
        });
        let usage = fixture
            .usage(UsageRange::Week)
            .now_or_never()
            .expect("fixture usage resolves immediately")
            .expect("fixture usage");
        app.handle_message(AppMessage::Usage {
            request_id: app.usage.request_id,
            result: Ok(usage),
        });
        app
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    #[test]
    fn initial_requests_are_read_only_and_deduplicated() {
        let mut app = App::new(AppInfo {
            backend_label: "DEMO",
            root: "demo".into(),
            node: "demo".into(),
            demo: true,
            read_only: false,
            ascii: false,
            no_color: true,
            appearance: Appearance::Dark,
            refresh_secs: 5,
        });
        let requests = app.pending_requests.len();
        assert!(requests >= 3);
        app.queue_provider_refresh();
        assert_eq!(app.pending_requests.len(), requests);
    }

    #[test]
    fn provider_actions_require_confirmation_and_start_with_cancel() {
        let mut app = app();
        app.handle_key(key(KeyCode::Char('2')));
        app.handle_key(key(KeyCode::Char('u')));
        match app.modal.as_ref().unwrap() {
            Modal::Confirm(dialog) => {
                assert!(!dialog.confirm_focused);
                assert_eq!(dialog.action.kind, ActionKind::Start);
            }
            _ => panic!("expected confirm modal"),
        }
        app.handle_key(key(KeyCode::Enter));
        assert!(app.effects.is_empty());
        assert!(app.active_task.is_none());
    }

    #[test]
    fn confirmation_starts_exactly_one_task() {
        let mut app = app();
        app.handle_key(key(KeyCode::Char('2')));
        app.handle_key(key(KeyCode::Char('R')));
        app.handle_key(key(KeyCode::Right));
        app.handle_key(key(KeyCode::Enter));
        assert_eq!(app.effects.len(), 1);
        assert!(matches!(app.effects[0], AppEffect::RunAction { .. }));
        assert!(app.active_task.is_some());
        let effects = app.effects.len();
        app.handle_key(key(KeyCode::Char('q')));
        assert_eq!(app.effects.len(), effects);
        assert!(app.active_task.is_some());
    }

    #[test]
    fn read_only_blocks_action_confirmation() {
        let mut app = app();
        app.info.read_only = true;
        app.handle_key(key(KeyCode::Char('2')));
        app.handle_key(key(KeyCode::Char('u')));
        assert!(app.modal.is_none());
        assert!(app.notice.as_ref().is_some_and(|notice| notice.error));
    }

    #[test]
    fn leaving_logs_page_clears_filter_and_requests_log() {
        let mut app = app();
        app.handle_key(key(KeyCode::Char('5')));
        assert!(!app.pending_requests.is_empty());
        app.handle_key(key(KeyCode::Char('k')));
        assert!(!app.log_follow);
    }

    #[test]
    fn log_filter_navigation_moves_between_matches() {
        let mut app = app();
        // 先进日志页：切换页面会清掉上一个 provider 的已加载内容。
        app.handle_key(key(KeyCode::Char('5')));
        app.log_lines = vec![
            "alpha one".into(),
            "beta".into(),
            "alpha two".into(),
            "gamma".into(),
            "alpha three".into(),
        ];
        app.log_filter = "alpha".into();
        assert_eq!(app.log_match_count(), 3);
        assert_eq!(app.visible_log_lines().len(), 3);

        app.handle_key(key(KeyCode::Char('n')));
        assert_eq!(app.log_match, Some(0));
        app.handle_key(key(KeyCode::Char('n')));
        assert_eq!(app.log_match, Some(1));
        app.handle_key(key(KeyCode::Char('N')));
        assert_eq!(app.log_match, Some(0));
        // 向后回绕到最后一个命中。
        app.handle_key(key(KeyCode::Char('N')));
        assert_eq!(app.log_match, Some(2));
        assert!(!app.log_follow);
    }

    #[test]
    fn log_filter_without_matches_reports_and_clears_position() {
        let mut app = app();
        app.handle_key(key(KeyCode::Char('5')));
        app.log_lines = vec!["alpha".into()];
        app.log_filter = "zzz".into();
        app.handle_key(key(KeyCode::Char('n')));
        assert_eq!(app.log_match, None);
        assert!(app.notice.as_ref().is_some_and(|notice| notice.error));
    }

    #[test]
    fn log_match_position_is_clamped_after_new_content() {
        let mut app = app();
        app.handle_key(key(KeyCode::Char('5')));
        app.log_lines = (0..5).map(|i| format!("alpha {i}")).collect();
        app.log_filter = "alpha".into();
        for _ in 0..4 {
            app.handle_key(key(KeyCode::Char('n')));
        }
        assert_eq!(app.log_match, Some(3));

        // 刷新后只剩两行命中：落点必须回到有效范围，不能显示「第 4/2 处」。
        app.log_lines = vec!["alpha 0".into(), "beta".into(), "alpha 1".into()];
        app.handle_message(AppMessage::Logs {
            request_id: app.log_request_id,
            provider_id: app.selected_provider_id().unwrap(),
            result: Ok(crate::domain::TextResult {
                text: app.log_lines.join("\n"),
                exit_code: Some(0),
                truncated: false,
            }),
        });
        assert_eq!(app.log_match_count(), 2);
        assert_eq!(app.log_match, Some(1));
    }

    #[test]
    fn gateway_cannot_be_toggled_with_on_off() {
        let mut app = app();
        app.page = Page::Providers;
        let index = app
            .providers
            .data
            .as_ref()
            .unwrap()
            .providers
            .iter()
            .position(|provider| provider.overlay())
            .expect("fixture includes the gateway overlay");
        app.provider_cursor = index;
        app.handle_key(key(KeyCode::Char('o')));
        assert!(app.modal.is_none());
        assert!(app
            .notice
            .as_ref()
            .is_some_and(|notice| notice.text.contains("gateway")));
        app.handle_key(key(KeyCode::Char('x')));
        assert!(app.modal.is_none());
    }

    #[test]
    fn numeric_page_shortcuts_keep_the_selected_provider() {
        let mut app = app();
        // 额度页按 4 应该带着选中额度行的 provider 跳到账号页。
        app.page = Page::Credits;
        let target = app.quota_lines()[app.quota_cursor].provider.clone();
        app.handle_key(key(KeyCode::Char('4')));
        assert_eq!(app.page, Page::Accounts);
        assert_eq!(app.selected_provider_id().as_deref(), Some(target.as_str()));

        // 账号页按 3 应该带着选中账号的 provider 跳到额度页。
        app.page = Page::Accounts;
        let target = app.selected_account().unwrap().group.id.clone();
        app.handle_key(key(KeyCode::Char('3')));
        assert_eq!(app.page, Page::Credits);
        assert_eq!(app.selected_provider_id().as_deref(), Some(target.as_str()));
    }

    #[test]
    fn usage_range_changes_force_a_new_request() {
        let mut app = app();
        let before = app.usage_request_seq;
        app.handle_key(key(KeyCode::Char('7')));
        assert_eq!(app.page, Page::Usage);
        app.handle_key(key(KeyCode::Char('t')));
        assert_eq!(app.usage_range, UsageRange::Month);
        assert!(app.usage_request_seq > before);
        app.handle_message(AppMessage::Usage {
            request_id: app.usage.request_id,
            result: Ok(crate::backend::fixture::FixtureBackend::new(false)
                .usage(UsageRange::Month)
                .now_or_never()
                .unwrap()
                .unwrap()),
        });
        assert!(app.selected_usage_model().is_some());
    }

    #[test]
    fn unknown_message_is_ignored() {
        let mut app = app();
        app.handle_message(AppMessage::Providers {
            request_id: 999,
            result: Err(BackendError::new("stale")),
        });
        assert!(app.providers.error.is_none());
    }

    #[test]
    fn refresh_failure_keeps_old_data_and_explains_stale_state() {
        let mut app = app();
        let request_id = app.providers.request_id;
        app.handle_message(AppMessage::Providers {
            request_id,
            result: Err(BackendError::new("node failed")),
        });
        assert!(app.providers.data.is_some());
        assert!(app.providers.error.is_some());
        assert!(app
            .notice
            .as_ref()
            .is_some_and(|notice| notice.error && notice.text.contains("node failed")));
    }
}
