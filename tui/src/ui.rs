//! TUI 渲染根：统一布局（header / tabs / body / summary / footer）+ 弹窗。
//!
//! 视觉规则（改动前先读 [`theme`]）：
//! - 顶部 1 行：品牌、后端、只读标记、root、数据新鲜度、错误指示、时钟。
//! - 第 2 行：页签，当前页高亮 + 下划线。
//! - 主内容：由 `pages::*` 按断点排版。
//! - 倒数第 2 行：上下文摘要（选中项 / 最近操作 / 提示）。
//! - 最后 1 行：随页面变化的键位提示。
//!
//! 所有动态文本都经过 `safe_inline` / `safe_block` 清洗，避免终端转义注入。

pub mod common;
pub mod layout;
pub mod modals;
pub mod pages;
pub mod theme;
pub mod widgets;

use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Paragraph, Wrap};
use ratatui::Frame;

use crate::app::{App, Page};
use crate::domain::ActionRisk;

use common::{age, error_count, provider_stats, resource_state, safe_inline, tab_title, utc_clock};
use layout::{Breakpoint, Shell};
use theme::{fit_width, Theme, Tone};

pub fn draw(frame: &mut Frame, app: &mut App) {
    let area = frame.area();
    if area.width < 40 || area.height < 12 {
        let message = format!(
            "终端过小（{}×{}）\n至少需要 40×12；请调整窗口后继续。\n\nq 退出",
            area.width, area.height
        );
        frame.render_widget(Paragraph::new(message).wrap(Wrap { trim: false }), area);
        return;
    }

    let theme = Theme::new(app);
    let shell = Shell::split(area);
    render_header(frame, shell.header, app, theme);
    render_tabs(frame, shell.tabs, app, theme);
    render_page(frame, shell.body, app, theme);
    render_summary(frame, shell.summary, app, theme);
    render_footer(frame, shell.footer, app, theme);
    modals::render(frame, area, app, theme);
}

fn render_header(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let glyphs = theme.glyphs();
    let breakpoint = Breakpoint::of(area.width);
    let mut spans = vec![
        Span::styled(
            if glyphs.ascii() {
                " Router Control "
            } else {
                " ◆ Router Control "
            },
            theme.bold(Tone::Accent),
        ),
        Span::styled(
            format!(" {} ", app.info.backend_label),
            if app.info.demo {
                theme.badge(Tone::Warning)
            } else {
                theme.badge(Tone::Success)
            },
        ),
    ];
    if app.info.read_only {
        spans.push(Span::styled(" 只读 ", theme.badge(Tone::Warning)));
    }
    if breakpoint.shows_notes() {
        spans.push(Span::styled(
            format!(" {}", fit_width(&app.info.root, 28, glyphs.ellipsis())),
            theme.muted(),
        ));
    }

    // 右侧：数据新鲜度 + 错误指示 + 时钟。先算宽度，左侧再截断。
    let mut right = Vec::new();
    if breakpoint.shows_notes() {
        let (label, tone) = resource_state(&app.providers);
        right.push(Span::styled(format!("状态 {label}"), theme.fg(tone)));
        right.push(Span::styled(
            format!(" {} ", glyphs.bullet()),
            theme.muted(),
        ));
    }
    if app.page == Page::Usage {
        let (label, tone) = resource_state(&app.usage);
        right.push(Span::styled(format!("用量 {label}"), theme.fg(tone)));
        right.push(Span::styled(
            format!(" {} ", glyphs.bullet()),
            theme.muted(),
        ));
    }
    if let Some(task) = app.active_task.as_ref() {
        right.push(Span::styled(
            format!(
                "任务 {} {}s",
                task.action.title(),
                task.started.elapsed().as_secs()
            ),
            theme.badge(Tone::Warning),
        ));
        right.push(Span::raw(" "));
    }
    let errors = error_count(app);
    if errors > 0 {
        right.push(Span::styled(
            format!(" {} {} 错误 ", glyphs.bad(), errors),
            theme.badge(Tone::Error),
        ));
    }
    right.push(Span::styled(utc_clock(), theme.muted()));

    let right_width: usize = right.iter().map(Span::width).sum();
    let left_width: usize = spans.iter().map(Span::width).sum();
    let available = area.width as usize;
    if left_width + right_width < available {
        let padding = available - left_width - right_width;
        spans.push(Span::raw(" ".repeat(padding)));
        spans.extend(right);
    } else {
        // 空间不足：只保留错误指示与时钟，左侧截断 root。
        let mut trimmed = Vec::new();
        trimmed.push(spans[0].clone());
        trimmed.push(spans[1].clone());
        let right_width: usize = right.iter().map(Span::width).sum();
        let budget = available.saturating_sub(right_width + 1);
        let title = fit_width(" Router Control", budget, glyphs.ellipsis());
        trimmed.push(Span::styled(title, theme.bold(Tone::Normal)));
        let used: usize = trimmed.iter().map(Span::width).sum();
        trimmed.push(Span::raw(
            " ".repeat(available.saturating_sub(used + right_width)),
        ));
        trimmed.extend(right);
        frame.render_widget(Paragraph::new(Line::from(trimmed)), area);
        return;
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

fn render_tabs(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let breakpoint = Breakpoint::of(area.width);
    let compact = breakpoint.is_compact();
    let mut spans = Vec::new();
    for (index, page) in Page::ALL.iter().enumerate() {
        let active = app.page == *page;
        let style = if active {
            theme.tab_active()
        } else {
            theme.muted()
        };
        spans.push(Span::styled(
            format!(" {} ", tab_title(*page, index, compact)),
            style,
        ));
        if !active {
            spans.push(Span::styled(
                if theme.ascii() { "|" } else { "│" },
                theme.muted(),
            ));
        }
    }
    if !compact {
        spans.push(Span::styled(" ? 帮助", theme.muted()));
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

fn render_page(frame: &mut Frame, area: Rect, app: &mut App, theme: Theme) {
    match app.page {
        Page::Overview => pages::overview::render(frame, area, app, theme),
        Page::Providers => pages::providers::render(frame, area, app, theme),
        Page::Credits => pages::credits::render(frame, area, app, theme),
        Page::Accounts => pages::accounts::render(frame, area, app, theme),
        Page::Logs => pages::logs::render(frame, area, app, theme),
        Page::Diagnostics => pages::diagnostics::render(frame, area, app, theme),
        Page::Usage => pages::usage::render(frame, area, app, theme),
    }
}

fn render_summary(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let glyphs = theme.glyphs();
    let breakpoint = Breakpoint::of(area.width);
    if let Some(task) = app.active_task.as_ref() {
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(glyphs.warn(), theme.badge(Tone::Warning)),
                Span::styled(
                    format!(
                        " {} 运行中 · {}s · 写任务期间不能退出",
                        task.action.title(),
                        task.started.elapsed().as_secs()
                    ),
                    theme.fg(Tone::Warning),
                ),
            ])),
            area,
        );
        return;
    }
    if let Some(notice) = app.notice.as_ref() {
        let tone = if notice.error {
            Tone::Error
        } else {
            Tone::Success
        };
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(
                    if notice.error {
                        glyphs.bad()
                    } else {
                        glyphs.ok()
                    },
                    theme.badge(tone),
                ),
                Span::styled(
                    format!(
                        " {}",
                        fit_width(
                            &safe_inline(&notice.text),
                            area.width.saturating_sub(3) as usize,
                            glyphs.ellipsis()
                        )
                    ),
                    theme.fg(tone),
                ),
            ])),
            area,
        );
        return;
    }

    // 有真实数据源错误时，摘要行优先显示它，而不是「一切正常」的选中项信息。
    if let Some((text, tone)) = common::first_error(app) {
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(glyphs.bad(), theme.badge(tone)),
                Span::styled(
                    format!(
                        " {}",
                        fit_width(
                            &text,
                            area.width.saturating_sub(3) as usize,
                            glyphs.ellipsis()
                        )
                    ),
                    theme.fg(tone),
                ),
            ])),
            area,
        );
        return;
    }

    let line = match app.page {
        Page::Usage => usage_summary(app, theme),
        _ => provider_summary_line(app, theme, breakpoint),
    };
    frame.render_widget(Paragraph::new(line), area);
}

fn provider_summary_line<'a>(app: &App, theme: Theme, breakpoint: Breakpoint) -> Line<'a> {
    let glyphs = theme.glyphs();
    if let Some(provider) = app.selected_provider() {
        let auth = provider.auth.effective_state();
        let mut spans = vec![
            Span::styled(
                fit_width(&safe_inline(&provider.title), 18, glyphs.ellipsis()),
                theme.provider(&provider.id),
            ),
            Span::styled(format!(" :{} ", provider.port), theme.muted()),
            Span::styled(
                if breakpoint.is_compact() {
                    format!(
                        "{}·{}",
                        provider.switch_label(),
                        if provider.up { "运行" } else { "停止" }
                    )
                } else {
                    format!(
                        "开关={} 进程={} 客户端={}",
                        provider.switch_label(),
                        if provider.up { "运行" } else { "停止" },
                        provider.client_label()
                    )
                },
                if provider.drift() {
                    theme.fg(Tone::Warning)
                } else {
                    theme.muted()
                },
            ),
            Span::raw("  "),
            Span::styled(
                format!("认证 {}", auth.label()),
                theme.fg(common::auth_tone(auth)),
            ),
        ];
        if provider.drift() && breakpoint.shows_notes() {
            spans.push(Span::raw("  "));
            spans.push(Span::styled(
                format!("{} {}", glyphs.warn(), common::drift_description(provider)),
                theme.fg(Tone::Warning),
            ));
        }
        return Line::from(spans);
    }
    let stats = provider_stats(app);
    if stats.total == 0 {
        return Line::from(Span::styled(
            "尚未加载 provider 状态；真实后端需要 Node.js 与 router root。",
            theme.fg(Tone::Warning),
        ));
    }
    Line::from(vec![
        Span::styled(
            format!("{} 个 provider", stats.total),
            theme.bold(Tone::Normal),
        ),
        Span::styled(
            format!(
                " · 启用 {}/{} · 运行 {} · 漂移 {}",
                stats.enabled, stats.managed, stats.up, stats.drift
            ),
            theme.muted(),
        ),
    ])
}

fn usage_summary<'a>(app: &App, theme: Theme) -> Line<'a> {
    let glyphs = theme.glyphs();
    if let Some(model) = app.sorted_usage_model() {
        return Line::from(vec![
            Span::styled(
                fit_width(&safe_inline(&model.model.id), 24, glyphs.ellipsis()),
                theme.provider(&model.model.provider_id),
            ),
            Span::styled(
                format!(
                    " {} steps · {} · ",
                    model.steps,
                    safe_inline(&model.model.provider_id)
                ),
                theme.muted(),
            ),
            Span::styled(
                format!(
                    "范围 {} · 数据 {}",
                    app.usage_range.label(),
                    age(app.usage.last_success)
                ),
                theme.muted(),
            ),
        ]);
    }
    Line::from(Span::styled(
        "OpenCode 用量尚未加载；按 r 重试。",
        theme.fg(Tone::Warning),
    ))
}

fn render_footer(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let breakpoint = Breakpoint::of(area.width);
    let common = "r刷新 O输出 ?帮助 q退出";
    let specific = match app.page {
        Page::Overview => {
            if breakpoint.is_compact() {
                "↑↓选择 Enter详情 2服务"
            } else {
                "↑↓选择 Enter详情 2服务 3额度 5日志"
            }
        }
        Page::Providers => {
            if breakpoint.is_compact() {
                "u启动 d停止 R重启 x关闭"
            } else {
                "u启动 d停止 K保留 R重启 o仅启用 x关闭 s同步 A全启 N全关 L日志"
            }
        }
        Page::Credits => {
            if breakpoint.is_compact() {
                "↑↓选择 Enter详情"
            } else {
                "↑↓选择 Enter详情 c签到 4账号"
            }
        }
        Page::Accounts => {
            if breakpoint.is_compact() {
                "↑↓选择 Enter详情 c切换"
            } else {
                "↑↓选择 v预览 c切换 a整池 A添加 L登录 3额度"
            }
        }
        Page::Logs => {
            if breakpoint.is_compact() {
                "p跟随 f过滤 n/N命中"
            } else {
                "p跟随 f过滤 n/N命中 +/-行数 c清屏 End底部 ↑↓滚动 ←→来源"
            }
        }
        Page::Diagnostics => {
            if breakpoint.is_compact() {
                "d自检 h健康 P试打"
            } else {
                "d自检 h健康 P试打 5日志 ←→来源 ↑↓滚动"
            }
        }
        Page::Usage => {
            if breakpoint.is_compact() {
                "↑↓选择 t范围 s排序"
            } else {
                "↑↓选择模型 Enter详情 t时间 s排序 r刷新"
            }
        }
    };
    let mut spans = vec![Span::styled(format!(" {common}"), theme.muted())];
    if breakpoint.is_compact() {
        spans.push(Span::styled("  ", theme.muted()));
        spans.push(Span::styled(specific.to_string(), theme.muted()));
    } else {
        spans.push(Span::styled(
            if theme.ascii() { "  |  " } else { "  │  " },
            theme.muted(),
        ));
        spans.push(Span::styled(specific.to_string(), theme.muted()));
    }
    if app.info.read_only {
        spans.push(Span::styled("  只读", theme.badge(Tone::Warning)));
    }
    if app
        .modal
        .as_ref()
        .is_some_and(|modal| matches!(modal, crate::app::Modal::Confirm(dialog) if dialog.action.risk() == ActionRisk::High))
    {
        spans.push(Span::styled("  高风险", theme.badge(Tone::Error)));
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

#[cfg(test)]
mod tests;
