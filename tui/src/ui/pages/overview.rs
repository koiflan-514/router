//! 总览页：KPI 条 + provider 紧凑表 + 右栏仪表。
//!
//! 宽屏（>=120）主表与右栏并排；80–119 单栏，attention 行放到表格下方；
//! <80 只保留 KPI 与关键列。

use ratatui::layout::{Constraint, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Cell, Row, Table, TableState};
use ratatui::Frame;

use crate::app::App;
use crate::domain::{format_compact, Provider};

use crate::ui::common::{
    claimable_count, compact_quota, first_quota_for, process_label, process_tone, provider_stats,
    quota_alert_count, quota_line_ratio, safe_inline,
};
use crate::ui::layout::{self, Breakpoint};
use crate::ui::theme::{fit_width, Theme, Tone};
use crate::ui::widgets::{self, Kpi, Segment};

pub fn render(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let breakpoint = Breakpoint::of(area.width);
    let kpi_height = if area.height >= 22 { 4 } else { 3 };
    let (kpi_area, rest) = layout::split_kpi(area, kpi_height);
    render_kpis(frame, kpi_area, app, theme, breakpoint);

    match breakpoint {
        Breakpoint::Wide => {
            let (main, sidebar) = layout::split_sidebar(rest, breakpoint);
            render_provider_table(frame, main, app, theme, breakpoint);
            if let Some(sidebar) = sidebar {
                render_sidebar(frame, sidebar, app, theme);
            }
        }
        Breakpoint::Standard => {
            // attention 行数跟着实际待办数量走，最多 4 行，但不挤掉表格的 6 行。
            let items = crate::ui::common::attention_items(app).len();
            let wanted = (items.clamp(1, 4) as u16) + 2;
            let attention_height = if rest.height >= 14 {
                wanted.min(rest.height.saturating_sub(6))
            } else {
                0
            };
            let chunks = ratatui::layout::Layout::vertical([
                Constraint::Min(6),
                Constraint::Length(attention_height),
            ])
            .split(rest);
            render_provider_table(frame, chunks[0], app, theme, breakpoint);
            if attention_height >= 3 {
                render_attention(frame, chunks[1], app, theme);
            }
        }
        Breakpoint::Compact => {
            render_provider_table(frame, rest, app, theme, breakpoint);
        }
    }
}

fn render_kpis(frame: &mut Frame, area: Rect, app: &App, theme: Theme, breakpoint: Breakpoint) {
    let stats = provider_stats(app);
    let claimable = claimable_count(app);
    let alerts = quota_alert_count(app);
    let glyphs = theme.glyphs();
    let gateway = match stats.gateway_up {
        Some(true) => format!("{} 网关在线", glyphs.on()),
        Some(false) => format!("{} 网关已停", glyphs.off()),
        None => "网关未知".into(),
    };

    let mut items = vec![
        Kpi::new(
            "运行 / 启用",
            format!("{}/{}", stats.up, stats.enabled),
            if stats.up == stats.enabled {
                Tone::Success
            } else {
                Tone::Warning
            },
        )
        .detail(format!("{}/{} 家参与开关", stats.enabled, stats.managed))
        .ratio(stats.enabled_ratio()),
        Kpi::new(
            "配置漂移",
            stats.drift.to_string(),
            if stats.drift == 0 {
                Tone::Success
            } else {
                Tone::Warning
            },
        )
        .detail(if stats.drift == 0 {
            "开关/进程/客户端一致"
        } else {
            "按 2 进服务修复"
        }),
        Kpi::new(
            "认证异常",
            stats.auth_problems.to_string(),
            if stats.auth_problems == 0 {
                Tone::Success
            } else {
                Tone::Error
            },
        )
        .detail(if stats.auth_problems == 0 {
            "全部可用"
        } else {
            "按 4 查看账号"
        }),
        Kpi::new(
            "可领取 / 告警",
            format!("{claimable} / {alerts}"),
            if alerts > 0 {
                Tone::Warning
            } else {
                Tone::Success
            },
        )
        .detail(gateway)
        .ratio(if claimable + alerts == 0 {
            1.0
        } else {
            claimable as f64 / (claimable + alerts) as f64
        }),
    ];
    if breakpoint.is_compact() {
        items.truncate(2);
    }
    widgets::render_kpis(frame, area, theme, &items);
}

fn render_provider_table(
    frame: &mut Frame,
    area: Rect,
    app: &App,
    theme: Theme,
    breakpoint: Breakpoint,
) {
    let stats = provider_stats(app);
    let title = if stats.total == 0 {
        "Provider".to_string()
    } else {
        format!(
            "Provider {} · 运行 {}/{}",
            stats.total, stats.up, stats.total
        )
    };
    let block = theme.panel_with_metric(title, Some("Enter 详情".into()));

    let Some(snapshot) = app.providers.data.as_ref() else {
        let message = if app.providers.refreshing {
            "正在读取 provider 状态…"
        } else if let Some(error) = app.providers.error.as_ref() {
            error.as_str()
        } else {
            "尚未加载 provider 状态；按 r 重试。"
        };
        frame.render_widget(widgets::placeholder(theme, message).block(block), area);
        return;
    };

    let (headers, widths) = columns_for(area.width, breakpoint);
    let rows = snapshot
        .providers
        .iter()
        .map(|provider| provider_row(app, provider, area.width, breakpoint, theme))
        .collect::<Vec<_>>();

    let table = Table::new(rows, widths)
        .header(Row::new(
            headers
                .into_iter()
                .map(|header| Cell::from(header).style(theme.table_header())),
        ))
        .block(block)
        .column_spacing(1)
        .highlight_symbol(theme.highlight_symbol())
        .row_highlight_style(theme.selected());
    let mut state = TableState::default().with_selected(Some(app.provider_cursor));
    frame.render_stateful_widget(table, area, &mut state);
}

fn columns_for(width: u16, breakpoint: Breakpoint) -> (Vec<&'static str>, Vec<Constraint>) {
    match breakpoint {
        Breakpoint::Wide => (
            vec![
                "",
                "Provider",
                "开关",
                "进程",
                "认证",
                "客户端",
                "端口",
                "模型",
                "额度",
            ],
            vec![
                Constraint::Length(1),
                Constraint::Min(14),
                Constraint::Length(4),
                Constraint::Length(7),
                Constraint::Length(12),
                Constraint::Length(7),
                Constraint::Length(5),
                Constraint::Length(4),
                Constraint::Min(10),
            ],
        ),
        Breakpoint::Standard => {
            if width >= 100 {
                (
                    vec![
                        "", "Provider", "开关", "进程", "认证", "端口", "模型", "额度",
                    ],
                    vec![
                        Constraint::Length(1),
                        Constraint::Min(14),
                        Constraint::Length(4),
                        Constraint::Length(7),
                        Constraint::Length(11),
                        Constraint::Length(5),
                        Constraint::Length(4),
                        Constraint::Min(9),
                    ],
                )
            } else {
                (
                    vec!["", "Provider", "开关", "进程", "认证", "额度"],
                    vec![
                        Constraint::Length(1),
                        Constraint::Min(12),
                        Constraint::Length(4),
                        Constraint::Length(7),
                        Constraint::Length(9),
                        Constraint::Min(8),
                    ],
                )
            }
        }
        Breakpoint::Compact => (
            vec!["", "Provider", "进程", "认证"],
            vec![
                Constraint::Length(1),
                Constraint::Min(10),
                Constraint::Length(7),
                Constraint::Length(8),
            ],
        ),
    }
}

fn provider_row(
    app: &App,
    provider: &Provider,
    width: u16,
    breakpoint: Breakpoint,
    theme: Theme,
) -> Row<'static> {
    let glyphs = theme.glyphs();
    let auth = provider.auth.effective_state();
    let tone = crate::ui::common::provider_tone(provider);
    let dot = Span::styled(
        match tone {
            Tone::Success => glyphs.on(),
            Tone::Warning => glyphs.warn(),
            Tone::Error => glyphs.bad(),
            _ => glyphs.off(),
        },
        theme.badge(tone),
    );
    let mut cells = vec![
        Cell::from(Line::from(dot)),
        cell(
            fit_width(&safe_inline(&provider.title), 18, glyphs.ellipsis()),
            theme.provider(&provider.id),
        ),
    ];

    match breakpoint {
        Breakpoint::Compact => {
            cells.push(cell(
                process_label(theme, provider.up),
                theme.fg(process_tone(provider.up)),
            ));
            cells.push(cell(
                fit_width(auth.label(), 8, glyphs.ellipsis()),
                theme.fg(crate::ui::common::auth_tone(auth)),
            ));
        }
        _ => {
            cells.push(cell(
                provider.switch_label(),
                if provider.overlay() {
                    theme.muted()
                } else if provider.on {
                    theme.fg(Tone::Success)
                } else {
                    theme.muted()
                },
            ));
            cells.push(cell(
                process_label(theme, provider.up),
                theme.fg(process_tone(provider.up)),
            ));
            cells.push(cell(
                fit_width(auth.label(), 11, glyphs.ellipsis()),
                theme.fg(crate::ui::common::auth_tone(auth)),
            ));
            if breakpoint.is_wide() {
                cells.push(cell(provider.client_short(), theme.muted()));
                cells.push(cell(format!("{:>5}", provider.port), theme.muted()));
            } else if width >= 100 {
                cells.push(cell(format!("{:>5}", provider.port), theme.muted()));
            }
            if !breakpoint.is_compact() && width >= 100 {
                cells.push(cell(
                    provider
                        .models
                        .map(|value| format!("{value:>3}"))
                        .unwrap_or_else(|| "  —".into()),
                    theme.muted(),
                ));
            }
            cells.push(cell(quota_cell(app, provider, theme), theme.muted()));
        }
    }
    Row::new(cells)
}

fn quota_cell(app: &App, provider: &Provider, theme: Theme) -> String {
    let Some(line) = first_quota_for(app, &provider.id) else {
        return compact_quota(app, &provider.id);
    };
    let Some(ratio) = quota_line_ratio(&line) else {
        return compact_quota(app, &provider.id);
    };
    format!(
        "{} {}",
        widgets::meter_string(theme, Some(ratio), 6),
        compact_quota(app, &provider.id)
    )
}

fn cell(text: impl Into<String>, style: ratatui::style::Style) -> Cell<'static> {
    Cell::from(text.into()).style(style)
}

fn render_sidebar(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    // 侧栏三块：健康度（固定）、额度 Top（固定）、趋势 + 待处理（余量）。
    // 高度够时：健康 6、额度 Top 7、趋势 5、待处理吃掉余量；
    // 高度不够时按比例压缩，仍然保证每块至少 3 行。
    let tight = area.height < 26;
    let chunks = if tight {
        ratatui::layout::Layout::vertical([
            Constraint::Length(5),
            Constraint::Length(5),
            Constraint::Length(4),
            Constraint::Min(3),
        ])
        .split(area)
    } else {
        ratatui::layout::Layout::vertical([
            Constraint::Length(6),
            Constraint::Length(7),
            Constraint::Length(5),
            Constraint::Min(3),
        ])
        .split(area)
    };
    render_health(frame, chunks[0], app, theme);
    render_quota_top(frame, chunks[1], app, theme);
    render_trend(frame, chunks[2], app, theme);
    render_attention(frame, chunks[3], app, theme);
}

fn render_health(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let stats = provider_stats(app);
    let block = theme.panel("健康度");
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.is_empty() {
        return;
    }
    // 左侧环形仪表，右侧两行图例；宽度不足 18 时只留环。
    let ring_width = inner.width.min(15);
    let chunks =
        ratatui::layout::Layout::horizontal([Constraint::Length(ring_width), Constraint::Min(2)])
            .spacing(1)
            .split(inner);
    // 环占上半，构成条占最后一行，两者不能重叠（重叠会把环的底边盖掉）。
    let meter_rows = u16::from(chunks[0].height >= 5);
    let ring_area = Rect {
        height: chunks[0].height.saturating_sub(meter_rows),
        ..chunks[0]
    };
    let label = format!("{:.0}%", stats.health_ratio() * 100.0);
    widgets::render_ring(
        frame.buffer_mut(),
        ring_area,
        theme,
        stats.health_ratio(),
        &label,
    );
    if chunks[1].width < 4 || chunks[1].height == 0 {
        return;
    }
    let glyphs = theme.glyphs();
    let mut lines = vec![
        widgets::legend_line(
            theme,
            &[
                (Tone::Success, format!("{} 健康", stats.healthy)),
                (Tone::Warning, format!("{} 漂移", stats.drift)),
            ],
        ),
        widgets::legend_line(
            theme,
            &[
                (Tone::Error, format!("{} 认证", stats.auth_problems)),
                (Tone::Muted, format!("{} 家", stats.total)),
            ],
        ),
        Line::from(Span::styled(
            fit_width(
                &format!("参与开关 {} 家", stats.managed),
                chunks[1].width as usize,
                glyphs.ellipsis(),
            ),
            theme.muted(),
        )),
    ];
    lines.truncate(chunks[1].height as usize);
    frame.render_widget(ratatui::widgets::Paragraph::new(lines), chunks[1]);

    // 环下方如果还有空行，画一条构成条，直观看出健康/漂移/认证比例。
    if meter_rows > 0 {
        let meter_area = Rect {
            x: chunks[0].x,
            y: chunks[0].bottom() - 1,
            width: chunks[0].width,
            height: 1,
        };
        widgets::render_segments(
            frame.buffer_mut(),
            meter_area,
            theme,
            &[
                Segment {
                    ratio: stats.healthy as f64,
                    tone: Tone::Success,
                },
                Segment {
                    ratio: stats.drift as f64,
                    tone: Tone::Warning,
                },
                Segment {
                    ratio: stats.auth_problems as f64,
                    tone: Tone::Error,
                },
            ],
        );
    }
}

fn render_quota_top(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let block = theme.panel_with_metric("额度 Top", Some("3 查看".into()));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let Some(credits) = app.credits.data.as_ref() else {
        frame.render_widget(widgets::placeholder(theme, "尚未取得额度数据"), inner);
        return;
    };
    let mut lines = Vec::new();
    let width = inner.width as usize;
    let mut rows: Vec<_> = app
        .quota_lines()
        .into_iter()
        .filter(|line| quota_line_ratio(line).is_some())
        .collect();
    rows.sort_by(|a, b| {
        let ratio_a = quota_line_ratio(a).unwrap_or(0.0);
        let ratio_b = quota_line_ratio(b).unwrap_or(0.0);
        ratio_a
            .partial_cmp(&ratio_b)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    if rows.is_empty() {
        lines.push(Line::from(Span::styled(
            format!("{} 个来源 · 无可用额度条", credits.rows.len()),
            theme.muted(),
        )));
    }
    for line in rows.into_iter().take(inner.height as usize) {
        let ratio = quota_line_ratio(&line).unwrap_or(0.0);
        let value = format!("{}%", (ratio * 100.0).round().clamp(0.0, 100.0) as i64);
        lines.push(widgets::meter_line(
            theme,
            &safe_inline(&line.title),
            ratio,
            value,
            width,
        ));
    }
    frame.render_widget(ratatui::widgets::Paragraph::new(lines), inner);
}

fn render_trend(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let values = crate::ui::common::activity_values(app, 7);
    let block = theme.panel_with_metric("近 7 天步骤", Some("7 用量".into()));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.is_empty() {
        return;
    }
    if values.is_empty() {
        let message = if app.usage.refreshing {
            "读取中…"
        } else {
            "无用量数据"
        };
        frame.render_widget(widgets::placeholder(theme, message), inner);
        return;
    }
    let label_rows = u16::from(inner.height >= 3);
    let chart_area = Rect {
        height: inner.height.saturating_sub(label_rows),
        ..inner
    };
    widgets::render_sparkline(frame, chart_area, theme, &values, "无活动");
    if label_rows > 0 {
        let total: u64 = values.iter().sum();
        frame.render_widget(
            ratatui::widgets::Paragraph::new(Line::from(vec![
                Span::styled("合计 ", theme.muted()),
                Span::styled(format_compact(total), theme.bold(Tone::Accent)),
                Span::styled(
                    format!(" · 峰值 {}", format_compact(widgets::peak(&values))),
                    theme.muted(),
                ),
            ])),
            Rect {
                y: inner.bottom() - 1,
                height: 1,
                ..inner
            },
        );
    }
}

fn render_attention(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let block = theme.panel("待处理");
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let items = crate::ui::common::attention_items(app);
    if items.is_empty() {
        frame.render_widget(
            ratatui::widgets::Paragraph::new(Line::from(vec![
                Span::styled(theme.glyphs().ok(), theme.fg(Tone::Success)),
                Span::raw(" "),
                Span::styled("没有待处理事项", theme.muted()),
            ])),
            inner,
        );
        return;
    }
    let glyphs = theme.glyphs();
    let width = inner.width as usize;
    let lines = items
        .iter()
        .take(inner.height as usize)
        .map(|item| {
            // 键位提示固定贴右：先算它的宽度，正文只占剩下的部分。
            let hint = format!("{} ", item.hint);
            let hint_width = crate::ui::theme::text_width(&hint);
            let text_width = width.saturating_sub(hint_width + 3);
            let mut spans = vec![
                Span::styled(
                    crate::ui::common::check_glyph(theme, item.tone),
                    theme.badge(item.tone),
                ),
                Span::raw(" "),
                Span::styled(
                    fit_width(&item.text, text_width, glyphs.ellipsis()),
                    theme.fg(item.tone),
                ),
            ];
            let used = 2 + crate::ui::theme::text_width(&fit_width(
                &item.text,
                text_width,
                glyphs.ellipsis(),
            ));
            if used + hint_width <= width {
                spans.push(Span::raw(" ".repeat(width - used - hint_width)));
            }
            spans.push(Span::styled(hint, theme.muted()));
            Line::from(spans)
        })
        .collect::<Vec<_>>();
    frame.render_widget(ratatui::widgets::Paragraph::new(lines), inner);
}
