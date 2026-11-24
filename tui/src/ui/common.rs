//! 页面之间共享的派生数据与格式化 helper。
//!
//! 这些函数全部是纯函数（或只读 `App`），便于单测；页面模块只负责排版。

use std::time::{Instant, SystemTime, UNIX_EPOCH};

use ratatui::text::{Line, Span};

use crate::app::{App, Page, QuotaLine};
use crate::domain::{format_percent, format_quota_remaining, AuthState, HealthLevel, Provider};
use crate::redact::sanitize_text;

use super::theme::{fit_width, safe_ratio, Theme, Tone};

/// 顶栏时钟：UTC `HH:MM:SSZ`，不引入时区依赖。
pub fn utc_clock() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    format!(
        "{:02}:{:02}:{:02}Z",
        (seconds / 3600) % 24,
        (seconds / 60) % 60,
        seconds % 60
    )
}

pub fn age(last: Option<Instant>) -> String {
    let Some(last) = last else {
        return "—".into();
    };
    let seconds = last.elapsed().as_secs();
    if seconds < 2 {
        "刚刚".into()
    } else if seconds < 60 {
        format!("{seconds}s")
    } else if seconds < 3600 {
        format!("{}m", seconds / 60)
    } else {
        format!("{}h", seconds / 3600)
    }
}

pub fn safe_inline(input: &str) -> String {
    sanitize_text(input)
        .text
        .replace('\n', " ")
        .trim_end()
        .to_string()
}

pub fn safe_block(input: &str) -> String {
    sanitize_text(input).text
}

pub fn yes_no(value: bool) -> &'static str {
    if value {
        "是"
    } else {
        "否"
    }
}

pub fn drift_description(provider: &Provider) -> String {
    if provider.overlay() {
        return "叠加层".into();
    }
    if !provider.drift() {
        return "一致".into();
    }
    let mut parts = Vec::new();
    if provider.on != provider.up {
        parts.push(if provider.on {
            "已启用但未运行"
        } else {
            "已停用但仍在运行"
        });
    }
    if provider.on != provider.oc && !provider.oc_user_owned {
        parts.push(if provider.oc {
            "开关关闭但客户端仍存在"
        } else {
            "开关开启但客户端未写入"
        });
    }
    parts.join("；")
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ProviderStats {
    pub total: usize,
    pub managed: usize,
    pub enabled: usize,
    pub up: usize,
    pub drift: usize,
    pub auth_problems: usize,
    pub healthy: usize,
    pub gateway_up: Option<bool>,
}

impl ProviderStats {
    pub fn health_ratio(&self) -> f64 {
        if self.total == 0 {
            0.0
        } else {
            safe_ratio(self.healthy as f64 / self.total as f64)
        }
    }

    pub fn enabled_ratio(&self) -> f64 {
        if self.managed == 0 {
            0.0
        } else {
            safe_ratio(self.enabled as f64 / self.managed as f64)
        }
    }
}

pub fn provider_stats(app: &App) -> ProviderStats {
    let Some(snapshot) = app.providers.data.as_ref() else {
        return ProviderStats::default();
    };
    let managed: Vec<&Provider> = snapshot
        .providers
        .iter()
        .filter(|provider| !provider.overlay())
        .collect();
    let healthy = snapshot
        .providers
        .iter()
        .filter(|provider| !provider.drift() && !provider.auth.effective_state().is_problem())
        .count();
    ProviderStats {
        total: snapshot.providers.len(),
        managed: managed.len(),
        enabled: managed.iter().filter(|provider| provider.on).count(),
        up: snapshot
            .providers
            .iter()
            .filter(|provider| provider.up)
            .count(),
        drift: snapshot
            .providers
            .iter()
            .filter(|provider| provider.drift())
            .count(),
        auth_problems: snapshot
            .providers
            .iter()
            .filter(|provider| provider.auth.effective_state().is_problem())
            .count(),
        healthy,
        gateway_up: snapshot
            .providers
            .iter()
            .find(|provider| provider.overlay())
            .map(|provider| provider.up),
    }
}

pub fn claimable_count(app: &App) -> usize {
    app.credits.data.as_ref().map_or(0, |credits| {
        credits.rows.iter().map(|row| row.claimable_count()).sum()
    })
}

pub fn quota_alert_count(app: &App) -> usize {
    app.credits.data.as_ref().map_or(0, |credits| {
        credits
            .rows
            .iter()
            .filter(|row| {
                row.quota_exhausted
                    || (!row.available)
                    || row
                        .accounts
                        .iter()
                        .any(|account| account.quota_exhausted || account.cooling)
            })
            .count()
    })
}

/// 单行额度的进度比例。只有同时知道 remaining 与 total 时才给值。
pub fn quota_ratio(remaining: Option<f64>, total: Option<f64>) -> Option<f64> {
    let (remaining, total) = (remaining?, total?);
    if !remaining.is_finite() || !total.is_finite() || total <= 0.0 {
        return None;
    }
    Some(safe_ratio(remaining / total))
}

pub fn quota_line_ratio(line: &QuotaLine) -> Option<f64> {
    quota_ratio(line.remaining, line.total)
}

/// Provider 在额度页里的第一条额度行，用于表格里的额度条。
pub fn first_quota_for(app: &App, provider_id: &str) -> Option<QuotaLine> {
    app.quota_lines()
        .into_iter()
        .find(|line| line.provider == provider_id)
}

pub fn compact_quota(app: &App, provider_id: &str) -> String {
    let Some(row) = app
        .credits
        .data
        .as_ref()
        .and_then(|credits| credits.rows.iter().find(|row| row.provider == provider_id))
    else {
        return "—".into();
    };
    if !row.available {
        return "不可用".into();
    }
    if !row.accounts.is_empty() {
        return format!("{} 账号", row.accounts.len());
    }
    if !row.buckets.is_empty() {
        let first = &row.buckets[0];
        let mut value = format_quota_remaining(first.remaining, &first.unit);
        if row.buckets.len() > 1 {
            value.push_str(&format!(" +{}", row.buckets.len() - 1));
        }
        return value;
    }
    if row.quota_exhausted {
        return "额度已耗尽".into();
    }
    match row.status_summary().chars().count() {
        0 => "—".into(),
        count if count > 14 => format!(
            "{}…",
            row.status_summary().chars().take(13).collect::<String>()
        ),
        _ => row.status_summary(),
    }
}

pub fn auth_tone(state: AuthState) -> Tone {
    match state {
        AuthState::Valid => Tone::Success,
        AuthState::Expiring => Tone::Warning,
        AuthState::Unknown => Tone::Warning,
        AuthState::Expired | AuthState::Missing => Tone::Error,
    }
}

pub fn health_tone(level: HealthLevel) -> Tone {
    match level {
        HealthLevel::Ok => Tone::Success,
        HealthLevel::Warn => Tone::Warning,
        HealthLevel::Error => Tone::Error,
        HealthLevel::Unknown => Tone::Muted,
    }
}

pub fn health_glyph(theme: Theme, level: HealthLevel) -> String {
    let glyphs = theme.glyphs();
    let symbol = match health_tone(level) {
        Tone::Success => glyphs.ok(),
        Tone::Warning => glyphs.warn(),
        Tone::Error => glyphs.bad(),
        _ => glyphs.unknown(),
    };
    format!("{symbol} {}", health_label(level))
}

pub fn health_label(level: HealthLevel) -> &'static str {
    match level {
        HealthLevel::Ok => "正常",
        HealthLevel::Warn => "注意",
        HealthLevel::Error => "异常",
        HealthLevel::Unknown => "未知",
    }
}

pub fn process_label(theme: Theme, up: bool) -> String {
    let glyphs = theme.glyphs();
    if up {
        format!("{} 运行", glyphs.on())
    } else {
        format!("{} 停止", glyphs.off())
    }
}

pub fn process_tone(up: bool) -> Tone {
    if up {
        Tone::Success
    } else {
        Tone::Warning
    }
}

pub fn provider_tone(provider: &Provider) -> Tone {
    if provider.auth.effective_state().is_problem() {
        Tone::Error
    } else if provider.drift() {
        Tone::Warning
    } else if provider.up {
        Tone::Success
    } else {
        Tone::Muted
    }
}

/// 待处理事项。`hint` 直接是「按 x 处理」的键位提示。
#[derive(Debug, Clone)]
pub struct Attention {
    pub tone: Tone,
    pub text: String,
    pub hint: String,
}

/// 顶栏数据源错误摘要（供摘要行在无 notice 时使用）。
pub fn first_error(app: &App) -> Option<(String, Tone)> {
    if let Some(error) = app.providers.error.as_ref() {
        return Some((
            format!("provider 刷新失败：{}", safe_inline(error)),
            Tone::Error,
        ));
    }
    if let Some(error) = app.accounts.error.as_ref() {
        return Some((
            format!("账号刷新失败：{}", safe_inline(error)),
            Tone::Warning,
        ));
    }
    if let Some(error) = app.credits.error.as_ref() {
        return Some((
            format!("额度刷新失败：{}", safe_inline(error)),
            Tone::Warning,
        ));
    }
    if let Some(error) = app.usage.error.as_ref() {
        return Some((
            format!("用量刷新失败：{}", safe_inline(error)),
            Tone::Warning,
        ));
    }
    None
}

pub fn attention_items(app: &App) -> Vec<Attention> {
    let mut items = Vec::new();
    if let Some(snapshot) = app.providers.data.as_ref() {
        for provider in snapshot.providers.iter().filter(|p| p.drift()) {
            items.push(Attention {
                tone: Tone::Warning,
                text: format!(
                    "{} 配置漂移：{}",
                    safe_inline(&provider.title),
                    drift_description(provider)
                ),
                hint: "2 服务修复".into(),
            });
        }
        for provider in snapshot
            .providers
            .iter()
            .filter(|p| p.auth.effective_state().is_problem())
        {
            items.push(Attention {
                tone: auth_tone(provider.auth.effective_state()),
                text: format!(
                    "{} 认证{}",
                    safe_inline(&provider.title),
                    provider.auth.effective_state().label()
                ),
                hint: "4 账号 / L 登录".into(),
            });
        }
    }
    if let Some(credits) = app.credits.data.as_ref() {
        for row in credits.rows.iter().filter(|row| row.quota_exhausted) {
            items.push(Attention {
                tone: Tone::Error,
                text: format!("{} 额度已耗尽", safe_inline(&row.title)),
                hint: "3 额度".into(),
            });
        }
    }
    if claimable_count(app) > 0 {
        items.push(Attention {
            tone: Tone::Info,
            text: format!("{} 处签到可领取", claimable_count(app)),
            hint: "3 额度".into(),
        });
    }
    if let Some(error) = app.providers.error.as_ref() {
        items.push(Attention {
            tone: Tone::Error,
            text: format!("provider 刷新失败：{}", safe_inline(error)),
            hint: "r 重试".into(),
        });
    }
    if let Some(error) = app.credits.error.as_ref() {
        items.push(Attention {
            tone: Tone::Warning,
            text: format!("额度刷新失败：{}", safe_inline(error)),
            hint: "r 重试".into(),
        });
    }
    items
}

/// 顶栏错误指示：任意数据源失败时返回数量。
pub fn error_count(app: &App) -> usize {
    [
        app.providers.error.is_some(),
        app.accounts.error.is_some(),
        app.credits.error.is_some(),
        app.usage.error.is_some(),
        app.log_error.is_some(),
        app.diag.error.is_some(),
    ]
    .into_iter()
    .filter(|failed| *failed)
    .count()
}

pub fn resource_state<T>(resource: &crate::app::Resource<T>) -> (String, Tone) {
    if resource.error.is_some() {
        (format!("{} 旧", age(resource.last_success)), Tone::Error)
    } else if resource.refreshing {
        ("刷新中".into(), Tone::Info)
    } else {
        (age(resource.last_success), Tone::Muted)
    }
}

/// 页签标题（窄屏省略数字前缀）。
pub fn tab_title(page: Page, index: usize, compact: bool) -> String {
    if compact {
        page.title().to_string()
    } else {
        format!("{} {}", index + 1, page.title())
    }
}

/// Token 构成条目：标签、数量、占比。
pub fn token_breakdown(app: &App) -> Vec<(&'static str, u64, Tone)> {
    let Some(usage) = app.usage.data.as_ref() else {
        return Vec::new();
    };
    vec![
        ("输入", usage.tokens.input, Tone::Accent),
        ("输出", usage.tokens.output, Tone::Success),
        ("推理", usage.tokens.reasoning, Tone::Info),
        ("缓存读", usage.tokens.cache.read, Tone::Muted),
        ("缓存写", usage.tokens.cache.write, Tone::Warning),
    ]
}

/// 近 N 天活动值（时间正序）。
pub fn activity_values(app: &App, days: usize) -> Vec<u64> {
    app.usage
        .data
        .as_ref()
        .map(|usage| {
            usage
                .activity
                .iter()
                .rev()
                .take(days)
                .map(|day| day.steps)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect()
        })
        .unwrap_or_default()
}

pub fn tool_success(app: &App) -> (Option<f64>, u64, u64) {
    match app.usage.data.as_ref() {
        Some(usage) => (
            usage.tools.totals.success_rate(),
            usage.tools.totals.succeeded,
            usage.tools.totals.calls,
        ),
        None => (None, 0, 0),
    }
}

pub fn usage_range_label(app: &App) -> &'static str {
    app.usage_range.label()
}

/// 日志级别解析：返回 (tone, 简短标签)。
pub fn log_level(line: &str) -> (Tone, &'static str) {
    let lower = line.to_ascii_lowercase();
    if lower.contains("error")
        || lower.contains("[err]")
        || lower.contains("fatal")
        || lower.contains("panic")
        || lower.contains("失败")
    {
        (Tone::Error, "ERR")
    } else if lower.contains("warn")
        || lower.contains("429")
        || lower.contains("retry")
        || lower.contains("timeout")
        || lower.contains("警告")
    {
        (Tone::Warning, "WRN")
    } else if lower.contains("debug") || lower.contains("[dbg]") {
        (Tone::Muted, "DBG")
    } else {
        (Tone::Info, "INF")
    }
}

/// 单行日志渲染：级别色 + 命中标记。
pub fn log_line<'a>(theme: Theme, line: &str, marked: bool, width: usize) -> Line<'a> {
    let (tone, label) = log_level(line);
    let glyphs = theme.glyphs();
    let prefix = if marked { "» " } else { "  " };
    let level_style = theme.fg(tone);
    let text_width = width.saturating_sub(6).max(8);
    let body = fit_width(line, text_width, glyphs.ellipsis());
    Line::from(vec![
        Span::styled(
            prefix,
            if marked {
                theme.bold(Tone::Warning)
            } else {
                theme.muted()
            },
        ),
        Span::styled(format!("{label} "), level_style),
        Span::styled(body, theme.fg(tone)),
    ])
}

/// 诊断 checklist 的一项。
#[derive(Debug, Clone)]
pub struct Check {
    pub label: &'static str,
    pub value: String,
    pub tone: Tone,
}

impl Check {
    pub fn ok(label: &'static str, value: impl Into<String>) -> Self {
        Self {
            label,
            value: value.into(),
            tone: Tone::Success,
        }
    }

    pub fn warn(label: &'static str, value: impl Into<String>) -> Self {
        Self {
            label,
            value: value.into(),
            tone: Tone::Warning,
        }
    }

    pub fn bad(label: &'static str, value: impl Into<String>) -> Self {
        Self {
            label,
            value: value.into(),
            tone: Tone::Error,
        }
    }
}

pub fn check_glyph(theme: Theme, tone: Tone) -> &'static str {
    let glyphs = theme.glyphs();
    match tone {
        Tone::Success => glyphs.ok(),
        Tone::Warning => glyphs.warn(),
        Tone::Error => glyphs.bad(),
        _ => glyphs.unknown(),
    }
}

/// 诊断页的 checklist（纯派生，不触发任何命令）。
pub fn diagnostic_checks(app: &App) -> Vec<Check> {
    let mut checks = Vec::new();
    checks.push(if app.providers.data.is_some() {
        Check::ok("provider JSON", provider_wire(app))
    } else if app.providers.error.is_some() {
        Check::bad("provider JSON", "加载失败")
    } else {
        Check::warn("provider JSON", "尚未加载")
    });
    checks.push(if app.accounts.data.is_some() {
        Check::ok("account JSON", account_wire(app))
    } else if app.accounts.error.is_some() {
        Check::bad("account JSON", "加载失败")
    } else {
        Check::warn("account JSON", "尚未加载")
    });
    checks.push(if app.credits.data.is_some() {
        Check::ok(
            "额度数据",
            format!(
                "{} 个来源",
                app.credits.data.as_ref().map_or(0, |c| c.rows.len())
            ),
        )
    } else {
        Check::warn("额度数据", "尚未加载")
    });
    checks.push(match crate::domain::PlatformCapability::login() {
        crate::domain::PlatformCapability::Supported => Check::ok("登录流程", "本平台可用"),
        crate::domain::PlatformCapability::Unsupported(_) => {
            Check::warn("登录流程", "受限（以实际命令为准）")
        }
    });
    checks.push(match crate::domain::PlatformCapability::autostart() {
        crate::domain::PlatformCapability::Supported => Check::ok("登录自启", "可用"),
        crate::domain::PlatformCapability::Unsupported(_) => Check::warn("登录自启", "仅 Windows"),
    });
    checks.push(Check::ok(
        "Node",
        format!(
            "{} · 刷新 {}s",
            safe_inline(&app.info.node),
            app.info.refresh_secs
        ),
    ));
    checks.push(if app.info.read_only {
        Check::warn("运行模式", "只读：写操作已禁用")
    } else if app.info.demo {
        Check::warn("运行模式", "DEMO：匿名数据")
    } else {
        Check::ok("运行模式", "LIVE：写操作需确认")
    });
    checks
}

pub fn provider_wire(app: &App) -> String {
    app.providers
        .data
        .as_ref()
        .map(|snapshot| {
            format!(
                "schema={} · {} · 告警={}",
                snapshot
                    .schema_version
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "legacy".into()),
                snapshot.generated_at.as_deref().unwrap_or("—"),
                snapshot.warnings.len()
            )
        })
        .unwrap_or_else(|| "—".into())
}

pub fn account_wire(app: &App) -> String {
    app.accounts
        .data
        .as_ref()
        .map(|snapshot| {
            format!(
                "schema={} · {} · 告警={}",
                snapshot
                    .schema_version
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "legacy".into()),
                snapshot.generated_at.as_deref().unwrap_or("—"),
                snapshot.warnings.len()
            )
        })
        .unwrap_or_else(|| "—".into())
}

/// 数量与比例的紧凑文案，例如 `116/120 · 96.7%`。
pub fn success_label(success: Option<f64>, succeeded: u64, calls: u64) -> String {
    if calls == 0 {
        "无调用".into()
    } else {
        format!("{succeeded}/{calls} · {}", format_percent(success))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_clock_has_fixed_shape() {
        let clock = utc_clock();
        assert_eq!(clock.len(), 9);
        assert!(clock.ends_with('Z'));
    }

    #[test]
    fn quota_ratio_rejects_missing_and_zero_total() {
        assert_eq!(quota_ratio(Some(1.0), Some(0.0)), None);
        assert_eq!(quota_ratio(Some(1.0), None), None);
        assert_eq!(quota_ratio(None, Some(2.0)), None);
        assert_eq!(quota_ratio(Some(1.0), Some(4.0)), Some(0.25));
        assert_eq!(quota_ratio(Some(f64::NAN), Some(4.0)), None);
    }

    #[test]
    fn log_levels_are_recognized() {
        assert_eq!(log_level("upstream error 500").0, Tone::Error);
        assert_eq!(log_level("upstream returned 429").0, Tone::Warning);
        assert_eq!(log_level("debug detail").0, Tone::Muted);
        assert_eq!(log_level("provider endpoint ready").0, Tone::Info);
    }

    #[test]
    fn success_label_handles_no_calls() {
        assert_eq!(success_label(None, 0, 0), "无调用");
        assert!(success_label(Some(0.5), 5, 10).contains("50.0%"));
    }
}
