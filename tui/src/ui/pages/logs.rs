//! 日志页：级别着色、过滤命中标记、跟随/暂停状态、滚动条。
//!
//! 日志正文用 Paragraph 逐行渲染，级别前缀与命中标记由 [`log_line`] 统一生成；
//! 整段上游文案只放在正文，不进标题说明。

use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Paragraph, Scrollbar, ScrollbarOrientation, ScrollbarState};
use ratatui::Frame;

use crate::app::App;

use crate::ui::common::{age, log_line, safe_inline};
use crate::ui::theme::{fit_width, Theme, Tone};
use crate::ui::widgets;

pub fn render(frame: &mut Frame, area: Rect, app: &mut App, theme: Theme) {
    let glyphs = theme.glyphs();
    let provider = app
        .selected_provider()
        .map(|provider| format!("{} :{}", safe_inline(&provider.title), provider.port))
        .unwrap_or_else(|| "无 provider".into());
    let follow = if app.log_follow {
        format!("{} 跟随", glyphs.on())
    } else {
        format!("{} 暂停", glyphs.off())
    };
    let follow_tone = if app.log_follow {
        Tone::Success
    } else {
        Tone::Warning
    };
    let filter = if app.log_filter.is_empty() {
        "无".to_string()
    } else {
        format!("\"{}\"", safe_inline(&app.log_filter))
    };
    let match_count = app.log_match_count();

    let header = Line::from(vec![
        Span::styled(
            fit_width(&provider, 26, glyphs.ellipsis()),
            theme.bold(Tone::Normal),
        ),
        Span::raw("  "),
        Span::styled(follow, theme.badge(follow_tone)),
        Span::raw("  "),
        Span::styled(
            format!(
                "{} 前 · {} 行/次",
                age(app.log_last_success),
                app.log_lines_per_fetch
            ),
            theme.muted(),
        ),
        Span::raw("  "),
        Span::styled(
            format!("过滤 {filter} · 命中 {match_count}"),
            if match_count > 0 {
                theme.fg(Tone::Info)
            } else {
                theme.muted()
            },
        ),
    ]);
    let status = if let Some(error) = app.log_error.as_ref() {
        Line::from(vec![
            Span::styled(glyphs.bad(), theme.badge(Tone::Error)),
            Span::raw(" "),
            Span::styled(
                fit_width(
                    &safe_inline(error),
                    area.width.saturating_sub(4) as usize,
                    glyphs.ellipsis(),
                ),
                theme.fg(Tone::Error),
            ),
        ])
    } else if app.log_refreshing {
        Line::from(Span::styled("正在读取日志…", theme.fg(Tone::Info)))
    } else {
        Line::from(Span::styled(
            "空格 / ANSI / 常见凭据已在显示前清理",
            theme.muted(),
        ))
    };
    let top = Layout::vertical([Constraint::Length(2), Constraint::Min(1)]).split(area);
    frame.render_widget(Paragraph::new(vec![header, status]), top[0]);

    let visible = app.visible_log_lines();
    let inner_height = top[1].height.saturating_sub(2).max(1) as usize;
    let max_scroll = visible.len().saturating_sub(inner_height) as u16;
    app.log_max_scroll = max_scroll;
    app.log_view_height = inner_height as u16;
    if app.log_follow {
        app.log_scroll = max_scroll;
        app.log_match = None;
    }
    let scroll = app.log_scroll.min(max_scroll);
    let match_position = app.log_match.filter(|_| match_count > 0);

    let title = format!(
        "日志 · {}/{} 行{}",
        visible.len(),
        app.log_lines.len(),
        match_position
            .map(|index| format!(" · 第 {}/{} 处", index + 1, match_count))
            .unwrap_or_default()
    );
    let block = theme.panel_with_metric(
        title,
        Some(if app.log_follow {
            "End 底部".into()
        } else {
            "p 跟随".into()
        }),
    );

    if visible.is_empty() {
        let message = if app.log_refreshing {
            "正在读取日志…"
        } else {
            "没有已加载日志；进入本页会读取日志，按 r 重试。"
        };
        frame.render_widget(widgets::placeholder(theme, message).block(block), top[1]);
        return;
    }

    let lines = visible
        .iter()
        .enumerate()
        .skip(scroll as usize)
        .take(inner_height)
        .map(|(index, line)| {
            log_line(
                theme,
                line,
                match_position == Some(index),
                top[1].width.saturating_sub(2) as usize,
            )
        })
        .collect::<Vec<_>>();
    let inner = block.inner(top[1]);
    frame.render_widget(Paragraph::new(lines).block(block), top[1]);

    if max_scroll > 0 {
        let mut state = ScrollbarState::new(visible.len())
            .position(scroll as usize)
            .viewport_content_length(inner_height);
        let scrollbar = Scrollbar::new(ScrollbarOrientation::VerticalRight)
            .symbols(glyphs.scrollbar_set())
            .thumb_style(theme.fg(Tone::Accent))
            .track_style(theme.muted())
            .begin_style(theme.muted())
            .end_style(theme.muted());
        frame.render_stateful_widget(scrollbar, inner, &mut state);
    }
}
