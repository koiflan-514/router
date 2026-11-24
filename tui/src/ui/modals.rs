//! 弹窗：确认、帮助、详情、输入。
//!
//! 视觉与页面统一（同一套 Panel），但行为完全不变：确认默认聚焦「取消」，
//! 高风险操作标题用错误色，Esc 一律取消。

use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Clear, Paragraph, Wrap};
use ratatui::Frame;

use crate::app::{App, Modal, Page};
use crate::domain::ActionRisk;

use super::common::{safe_block, safe_inline};
use super::layout::popup;
use super::theme::{Theme, Tone};

pub fn render(frame: &mut Frame, area: Rect, app: &mut App, theme: Theme) {
    let Some(modal) = app.modal.as_ref() else {
        return;
    };
    match modal {
        Modal::Confirm(dialog) => render_confirm(frame, area, dialog, theme),
        Modal::Help => render_help(frame, area, app, theme),
        Modal::Detail {
            title,
            text,
            scroll,
        } => render_detail(frame, area, title, text, *scroll, theme),
        Modal::Input(dialog) => render_input(frame, area, dialog, theme),
    }
}

fn render_confirm(frame: &mut Frame, area: Rect, dialog: &crate::app::ConfirmDialog, theme: Theme) {
    let glyphs = theme.glyphs();
    // 弹窗宽度先算出来，正文按它换行，再据此估算高度；
    // 只数 `\n` 会让「将关闭：…」这种长列表被截断。
    let popup_area = popup(area, 82, 8, 88);
    let body_width = popup_area.width.saturating_sub(2).max(20) as usize;
    let body_lines = wrapped_line_count(&dialog.body, body_width) as u16;
    let popup_area = popup(area, 82, body_lines + 5, 88);
    frame.render_widget(Clear, popup_area);
    let high = dialog.action.risk() == ActionRisk::High;
    let title_style = if high {
        theme.bold(Tone::Error)
    } else {
        theme.bold(Tone::Accent)
    };
    let block = ratatui::widgets::Block::bordered()
        .border_type(theme.border_type())
        .border_set(theme.border_set())
        .border_style(if high {
            theme.fg(Tone::Error)
        } else {
            theme.border()
        })
        .title(Span::styled(
            format!(" {} ", safe_inline(&dialog.title)),
            title_style,
        ));
    let inner = block.inner(popup_area);
    frame.render_widget(block, popup_area);
    let chunks = Layout::vertical([Constraint::Min(3), Constraint::Length(2)]).split(inner);
    frame.render_widget(
        Paragraph::new(safe_block(&dialog.body)).wrap(Wrap { trim: false }),
        chunks[0],
    );

    let cancel_style = if dialog.confirm_focused {
        theme.muted()
    } else {
        theme.selected()
    };
    let confirm_style = if dialog.confirm_focused {
        if high {
            theme.badge(Tone::Error)
        } else {
            theme.selected()
        }
    } else {
        theme.muted()
    };
    let buttons = Line::from(vec![
        Span::styled("[ 取消 ]", cancel_style),
        Span::raw("   "),
        Span::styled(format!("[ 确认{} ]", dialog.action.title()), confirm_style),
    ]);
    let hint = Line::from(vec![
        Span::styled(glyphs.warn(), theme.fg(Tone::Warning)),
        Span::styled(
            " Esc 取消 · ←/→ 切换 · Enter 执行当前按钮（默认取消）",
            theme.muted(),
        ),
    ]);
    frame.render_widget(Paragraph::new(vec![buttons, hint]), chunks[1]);
}

/// 估算一段文本在 `width` 列内换行后的行数（CJK 按 2 列计）。
fn wrapped_line_count(text: &str, width: usize) -> usize {
    if width == 0 {
        return text.lines().count().max(1);
    }
    text.lines()
        .map(|line| {
            let line_width = crate::ui::theme::text_width(line);
            if line_width == 0 {
                1
            } else {
                line_width.div_ceil(width)
            }
        })
        .sum::<usize>()
        .max(1)
}

fn render_help(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    // 留出 footer 与摘要行，弹窗不要盖住「q 退出」这类保命提示。
    let popup_area = popup(area, 86, area.height.saturating_sub(6), 100);
    frame.render_widget(Clear, popup_area);
    let block = theme.panel_with_metric("帮助", Some("Esc/q 关闭".into()));
    let inner = block.inner(popup_area);
    frame.render_widget(block, popup_area);
    frame.render_widget(
        Paragraph::new(safe_block(&help_text(app)))
            .wrap(Wrap { trim: false })
            .scroll((0, 0)),
        inner,
    );
}

fn render_detail(
    frame: &mut Frame,
    area: Rect,
    title: &str,
    text: &str,
    scroll: u16,
    theme: Theme,
) {
    let popup_area = popup(area, 88, area.height.saturating_sub(4), 100);
    frame.render_widget(Clear, popup_area);
    let block = theme.panel(safe_inline(title));
    let inner = block.inner(popup_area);
    frame.render_widget(block, popup_area);
    let chunks = Layout::vertical([Constraint::Min(1), Constraint::Length(1)]).split(inner);
    frame.render_widget(
        Paragraph::new(safe_block(text))
            .scroll((scroll, 0))
            .wrap(Wrap { trim: false }),
        chunks[0],
    );
    frame.render_widget(
        Paragraph::new(Span::styled("Esc/q 返回 · j/k 滚动", theme.muted())),
        chunks[1],
    );
}

fn render_input(frame: &mut Frame, area: Rect, dialog: &crate::app::InputDialog, theme: Theme) {
    let popup_area = popup(area, 72, 7, 90);
    frame.render_widget(Clear, popup_area);
    let block = theme.panel(safe_inline(&dialog.title));
    let inner = block.inner(popup_area);
    frame.render_widget(block, popup_area);
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(vec![
                Span::styled("> ", theme.bold(Tone::Accent)),
                Span::raw(safe_inline(&dialog.value)),
                Span::styled("_", theme.fg(Tone::Warning)),
            ]),
            Line::default(),
            Line::from(Span::styled(
                "Enter 应用 · Esc 取消 · Ctrl+U 清空",
                theme.muted(),
            )),
        ]),
        inner,
    );
}

fn help_text(app: &App) -> String {
    let page_help = match app.page {
        Page::Overview => {
            "总览\n↑↓/jk 选择 provider · Enter 详情 · 2 服务 · 3 额度 · 5 日志 · 6 诊断\nKPI 依次为：运行/启用、配置漂移、认证异常、可领取/告警"
        }
        Page::Providers => {
            "服务\nu 启动 · d 停止 · K 停止但保留客户端 · R 重启\no 仅启用此家（会关闭其他已启用项）\nx 关闭此家 · s 同步 · A 全部启用 · N 全部关闭\nL 日志 · Enter 详情\n网关是叠加层：不参与 on/off，用 node router.mjs gateway up/down"
        }
        Page::Credits => {
            "额度\n↑↓ 选择额度行 · Enter 详情 · r 刷新\nc 签到（当前后端未统一接入，只展示状态）\n4 转到相同 provider 的账号页"
        }
        Page::Accounts => {
            "账号\n↑↓ 选择 · Enter 详情 · v 预览切换 · c 正式切换\na 恢复整池 · A 添加账号 · L 登录 · 3 额度"
        }
        Page::Logs => {
            "日志\np 暂停/跟随 · f 过滤 · n/N 跳到下一个/上一个命中\n+/- 调整尾部行数 · c 清除视图（不删文件）\nEnd 底部 · Home 顶部 · ↑↓ 滚动 · ←→ 切换 provider\n级别前缀 INF/WRN/ERR/DBG 由内容推断，仅用于着色"
        }
        Page::Diagnostics => {
            "诊断\nd 运行 doctor · h 无试打健康检查 · P 真实试打（需确认）\n←→ 切换 provider · ↑↓ 滚动 · 5 日志"
        }
        Page::Usage => {
            "用量分析\n↑↓/jk 选择模型 · Enter 查看 Token/成本详情\nt 切换近 24 小时、近 7 天、近 30 天和全部历史\ns 循环排序：步骤 / Token / 成本 / 名称（只改展示顺序，不重新请求）\n数据来自 OpenCode experimental.session.stats；steps 是会话步骤，不等于 HTTP 请求数"
        }
    };
    let mode = if app.info.demo {
        "DEMO：只使用匿名内存数据，不启动 Node，不改变真实状态。"
    } else if app.info.read_only {
        "LIVE + READ-ONLY：可以读取真实状态，所有写操作和消耗型操作被禁用。"
    } else {
        "LIVE：写操作需弹窗确认；刷新不会自动启动、登录、签到或试打。"
    };
    format!(
        "{page_help}\n\n全局\n1–7 页面 · r 刷新 · O 最近输出 · ? 帮助 · q 退出 · Esc 关弹窗\n\n模式\n{mode}\n\n图例\n{} 运行 · {} 停止 · ✔ 正常 · ▲ 注意 · ✖ 异常 · ? 未知\n— = 未知/缺失（不是 0）；「旧」= 保留了旧数据。\n\n安全\n高风险默认取消；写任务期间不能退出；登录暂时交还终端。\n\n{backend} · {root}",
        theme_symbols(app, true),
        theme_symbols(app, false),
        backend = app.info.backend_label,
        root = app.info.root,
    )
}

fn theme_symbols(app: &App, on: bool) -> &'static str {
    if app.info.ascii {
        if on {
            "*"
        } else {
            "o"
        }
    } else if on {
        "●"
    } else {
        "○"
    }
}
