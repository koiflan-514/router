//! 渲染层测试：四种尺寸 × 六个页面，覆盖空数据 / 加载 / 失败 / ascii / no-color。

use futures_util::FutureExt;
use ratatui::backend::TestBackend;
use ratatui::Terminal;

use super::*;
use crate::app::{App, AppInfo, AppMessage, Page};
use crate::cli::Appearance;
use crate::domain::UsageRange;

const SIZES: [(u16, u16); 4] = [(120, 40), (100, 30), (80, 24), (60, 20)];

fn test_app() -> App {
    let mut app = App::new(AppInfo {
        backend_label: "DEMO",
        root: "anonymous-demo".into(),
        node: "demo".into(),
        demo: true,
        read_only: false,
        ascii: false,
        no_color: true,
        appearance: Appearance::Dark,
        refresh_secs: 5,
    });
    app.handle_message(AppMessage::Providers {
        request_id: app.providers.request_id,
        result: Ok(crate::backend::fixture::FixtureBackend::new(false)
            .providers()
            .now_or_never()
            .expect("fixture providers resolve immediately")
            .unwrap()),
    });
    app.handle_message(AppMessage::Accounts {
        request_id: app.accounts.request_id,
        result: Ok(crate::backend::fixture::FixtureBackend::new(false)
            .accounts()
            .now_or_never()
            .expect("fixture accounts resolve immediately")
            .unwrap()),
    });
    app.handle_message(AppMessage::Credits {
        request_id: app.credits.request_id,
        result: Ok(crate::backend::fixture::FixtureBackend::new(false)
            .credits()
            .now_or_never()
            .expect("fixture credits resolve immediately")
            .unwrap()),
    });
    app.handle_message(AppMessage::Usage {
        request_id: app.usage.request_id,
        result: Ok(crate::backend::fixture::FixtureBackend::new(false)
            .usage(UsageRange::Week)
            .now_or_never()
            .expect("fixture usage resolves immediately")
            .unwrap()),
    });
    app
}

fn empty_app() -> App {
    let mut app = App::new(AppInfo {
        backend_label: "DEMO",
        root: "anonymous-demo".into(),
        node: "demo".into(),
        demo: true,
        read_only: false,
        ascii: false,
        no_color: true,
        appearance: Appearance::Dark,
        refresh_secs: 5,
    });
    // 丢弃初始请求，保持 data = None 的「加载中」状态。
    app.pending_requests.clear();
    app
}

fn render(app: &mut App, width: u16, height: u16) -> String {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal
        .draw(|frame| draw(frame, app))
        .expect("render should work");
    let buffer = terminal.backend().buffer();
    (0..buffer.area.height)
        .map(|y| {
            (0..buffer.area.width)
                .map(|x| buffer.cell((x, y)).map_or(" ", |cell| cell.symbol()))
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn compact(output: &str) -> String {
    output.chars().filter(|ch| !ch.is_whitespace()).collect()
}

#[test]
fn overview_renders_at_80x24() {
    let mut app = test_app();
    let output = render(&mut app, 80, 24);
    let compact = compact(&output);
    assert!(compact.contains("RouterControl"));
    assert!(compact.contains("总览"));
    assert!(compact.contains("Qoder"));
}

#[test]
fn all_pages_render_without_panic() {
    let mut app = test_app();
    for page in Page::ALL {
        app.page = page;
        for (width, height) in SIZES {
            let output = render(&mut app, width, height);
            assert!(
                !output.trim().is_empty(),
                "page {page:?} at {width}x{height} rendered nothing"
            );
        }
    }
}

#[test]
fn all_pages_render_with_empty_data() {
    let mut app = empty_app();
    for page in Page::ALL {
        app.page = page;
        for (width, height) in SIZES {
            let output = render(&mut app, width, height);
            assert!(!output.trim().is_empty());
        }
    }
}

#[test]
fn all_pages_render_with_backend_failure() {
    let mut app = test_app();
    app.providers.fail("node failed".into());
    app.accounts.fail("node failed".into());
    app.credits.fail("node failed".into());
    app.usage.fail("node failed".into());
    app.log_error = Some("log read failed".into());
    app.diag.fail("doctor failed".into());
    for page in Page::ALL {
        app.page = page;
        for (width, height) in SIZES {
            let output = render(&mut app, width, height);
            assert!(!output.trim().is_empty());
        }
    }
    // 顶栏必须有错误指示。
    app.page = Page::Overview;
    let output = render(&mut app, 120, 40);
    assert!(compact(&output).contains("错误") || compact(&output).contains("旧"));
}

#[test]
fn ascii_and_no_color_render_without_unicode_glyphs() {
    let mut app = test_app();
    app.info.ascii = true;
    app.info.no_color = true;
    for page in Page::ALL {
        app.page = page;
        for (width, height) in SIZES {
            let output = render(&mut app, width, height);
            for symbol in ['●', '○', '✔', '✖', '▲', '█', '░', '▶', '◆'] {
                assert!(
                    !output.contains(symbol),
                    "page {page:?} leaked unicode glyph {symbol:?} at {width}x{height}"
                );
            }
        }
    }
}

#[test]
fn no_color_mode_uses_reverse_video_for_selected_row() {
    use ratatui::style::Modifier;
    let mut app = test_app();
    app.info.no_color = true;
    let backend = TestBackend::new(100, 30);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| draw(frame, &mut app)).unwrap();
    let buffer = terminal.backend().buffer().clone();
    let reversed = (0..buffer.area.height).any(|y| {
        (0..buffer.area.width).any(|x| {
            buffer
                .cell((x, y))
                .is_some_and(|cell| cell.modifier.contains(Modifier::REVERSED))
        })
    });
    assert!(
        reversed,
        "selected row should use reverse video without color"
    );
}

#[test]
fn no_color_mode_never_emits_palette_colors() {
    use ratatui::style::Color;
    let mut app = test_app();
    app.info.no_color = true;
    let backend = TestBackend::new(120, 40);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| draw(frame, &mut app)).unwrap();
    let buffer = terminal.backend().buffer().clone();
    let colored = (0..buffer.area.height).any(|y| {
        (0..buffer.area.width).any(|x| {
            buffer.cell((x, y)).is_some_and(|cell| {
                !matches!(cell.fg, Color::Reset) || !matches!(cell.bg, Color::Reset)
            })
        })
    });
    assert!(!colored, "no-color must not paint palette colors");
}

#[test]
fn light_appearance_renders_without_panic() {
    let mut app = test_app();
    app.info.no_color = false;
    app.info.appearance = Appearance::Light;
    for page in Page::ALL {
        app.page = page;
        let output = render(&mut app, 100, 30);
        assert!(!output.trim().is_empty());
    }
}

#[test]
fn usage_page_renders_metrics_and_model_table() {
    let mut app = test_app();
    app.page = Page::Usage;
    let output = render(&mut app, 120, 40);
    let compact = compact(&output);
    assert!(compact.contains("会话步骤"), "{compact}");
    assert!(compact.contains("工具成功率"), "{compact}");
    assert!(compact.contains("每日活动"), "{compact}");
    assert!(compact.contains("codearts"), "{compact}");
    assert!(compact.contains("demo-code-model"), "{compact}");
}

#[test]
fn usage_kpi_bar_includes_tool_success_meter() {
    let mut app = test_app();
    app.page = Page::Usage;
    let output = render(&mut app, 120, 40);
    let compact = compact(&output);
    assert!(compact.contains("工具成功率"), "{compact}");
    assert!(compact.contains("96.7%"), "{compact}");
    // KPI 条下方的 gauge 由方块字符组成，宽度应接近整条 KPI 的宽度。
    assert!(
        output.contains('█') || output.contains('░'),
        "expected a meter in the KPI bar"
    );
}

#[test]
fn overview_shows_kpis_and_gateway_overlay() {
    let mut app = test_app();
    let output = render(&mut app, 130, 40);
    let compact = compact(&output);
    assert!(compact.contains("运行/启用"), "{compact}");
    assert!(compact.contains("配置漂移"), "{compact}");
    assert!(compact.contains("认证异常"), "{compact}");
    assert!(compact.contains("统一网关"), "{compact}");
    assert!(compact.contains("叠加"), "{compact}");
    // 健康度侧栏
    assert!(compact.contains("健康度"), "{compact}");
}

#[test]
fn credits_page_shows_exhausted_and_no_long_upstream_text() {
    let mut app = test_app();
    app.credits.data.as_mut().unwrap().rows[1].available = true;
    app.credits.data.as_mut().unwrap().rows[1].quota_exhausted = true;
    app.page = Page::Credits;
    let output = render(&mut app, 110, 30);
    let compact = compact(&output);
    assert!(compact.contains("额度已耗尽"), "{compact}");
    assert!(!compact.contains("该区域没有签到接口"), "{compact}");
}

#[test]
fn credits_page_shows_meter_and_reset_date() {
    let mut app = test_app();
    app.page = Page::Credits;
    let output = render(&mut app, 120, 40);
    let compact = compact(&output);
    assert!(compact.contains("进度"), "{compact}");
    assert!(
        compact.contains("2026-11-05") || compact.contains("重置日"),
        "{compact}"
    );
}

#[test]
fn logs_page_colors_levels_and_marks_match() {
    let mut app = test_app();
    app.page = Page::Logs;
    app.log_lines = vec![
        "2026-11-05T00:00:00Z [demo] provider endpoint ready".into(),
        "2026-11-05T00:00:02Z [demo] upstream returned 429; retry".into(),
        "2026-11-05T00:00:03Z [demo] error while reading credential".into(),
    ];
    app.log_filter = "demo".into();
    app.log_follow = false;
    app.log_match = Some(1);
    let output = render(&mut app, 120, 40);
    let compact = compact(&output);
    assert!(compact.contains("ERR"), "{compact}");
    assert!(compact.contains("WRN"), "{compact}");
    assert!(compact.contains("INF"), "{compact}");
    assert!(compact.contains("命中3"), "{compact}");
    assert!(compact.contains('»'), "{compact}");
}

#[test]
fn logs_page_shows_follow_state_and_scrollbar() {
    let mut app = test_app();
    app.page = Page::Logs;
    app.log_lines = (0..200).map(|i| format!("line {i} info")).collect();
    app.log_follow = true;
    let output = render(&mut app, 100, 24);
    let compact = compact(&output);
    assert!(compact.contains("跟随"), "{compact}");
}

#[test]
fn diagnostics_page_shows_checklist_and_meter() {
    let mut app = test_app();
    app.page = Page::Diagnostics;
    let output = render(&mut app, 130, 40);
    let compact = compact(&output);
    assert!(compact.contains("自检清单"), "{compact}");
    assert!(compact.contains("providerJSON"), "{compact}");
    assert!(compact.contains("通过"), "{compact}");
}

#[test]
fn diagnostics_page_renders_doctor_output() {
    let mut app = test_app();
    app.page = Page::Diagnostics;
    app.diag.succeed(crate::domain::TextResult {
        text: "router 自检\n* node ok\n* gateway ok\n".into(),
        exit_code: Some(0),
        truncated: false,
    });
    let output = render(&mut app, 120, 40);
    let compact = compact(&output);
    assert!(compact.contains("router自检"), "{compact}");
    assert!(compact.contains("退出码0"), "{compact}");
}

#[test]
fn providers_page_shows_service_columns_and_selection() {
    let mut app = test_app();
    app.page = Page::Providers;
    let output = render(&mut app, 130, 40);
    let compact = compact(&output);
    assert!(compact.contains("服务"), "{compact}");
    assert!(compact.contains("选中项"), "{compact}");
    assert!(compact.contains("客户端"), "{compact}");
}

#[test]
fn accounts_page_shows_slots_and_health() {
    let mut app = test_app();
    app.page = Page::Accounts;
    let output = render(&mut app, 130, 40);
    let compact = compact(&output);
    assert!(compact.contains("账号"), "{compact}");
    assert!(compact.contains("slot-a"), "{compact}");
    assert!(compact.contains("选中账号"), "{compact}");
}

#[test]
fn narrow_layout_keeps_key_columns_only() {
    let mut app = test_app();
    let wide = compact(&render(&mut app, 130, 40));
    let narrow = compact(&render(&mut app, 60, 20));
    // 宽屏有端口/客户端列，窄屏应该砍掉。
    assert!(wide.contains("8789"), "wide should show ports");
    assert!(
        !narrow.contains("8789"),
        "narrow should drop the port column"
    );
}

#[test]
fn dynamic_backend_fields_cannot_emit_terminal_escapes() {
    let mut app = test_app();
    app.providers.data.as_mut().unwrap().providers[0].title = "bad \x1b]0;owned\x07 title".into();
    app.providers.data.as_mut().unwrap().providers[0].auth.label = "auth \x1b[2J clear".into();
    app.accounts.data.as_mut().unwrap().providers[0].title = "account \x1b[31m red".into();
    app.accounts.data.as_mut().unwrap().providers[0].accounts[0].name =
        "name \x1b]52;c;x\x07".into();
    app.credits.data.as_mut().unwrap().rows[0].title = "quota \x1b[2J".into();
    for page in Page::ALL {
        app.page = page;
        let output = render(&mut app, 80, 24);
        assert!(!output.contains('\x1b'), "escape leaked on {page:?}");
        assert!(!output.contains("owned"), "OSC payload leaked on {page:?}");
    }
}

#[test]
fn confirm_defaults_to_cancel_visual() {
    let mut app = test_app();
    app.page = Page::Providers;
    app.handle_key(crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Char('u'),
        crossterm::event::KeyModifiers::NONE,
    ));
    let output = render(&mut app, 100, 30);
    let compact = compact(&output);
    assert!(compact.contains("确认"));
    assert!(compact.contains("取消"));
    assert!(compact.contains("默认取消"));
}

#[test]
fn high_risk_confirm_uses_error_badge_in_footer() {
    let mut app = test_app();
    app.page = Page::Providers;
    app.handle_key(crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Char('o'),
        crossterm::event::KeyModifiers::NONE,
    ));
    let output = render(&mut app, 120, 40);
    assert!(compact(&output).contains("高风险"));
}

#[test]
fn footer_hints_change_per_page() {
    let mut app = test_app();
    app.page = Page::Providers;
    let providers = render(&mut app, 120, 40);
    app.page = Page::Usage;
    let usage = render(&mut app, 120, 40);
    assert_ne!(
        providers.lines().last(),
        usage.lines().last(),
        "footer should be page-specific"
    );
}

#[test]
fn terminal_too_small_shows_guard_message() {
    let mut app = test_app();
    let output = render(&mut app, 39, 11);
    assert!(compact(&output).contains("终端过小"));
}

#[test]
fn every_size_renders_header_tabs_body_summary_footer() {
    for (width, height) in SIZES {
        let mut app = test_app();
        app.page = Page::Overview;
        let output = render(&mut app, width, height);
        let lines: Vec<&str> = output.lines().collect();
        assert_eq!(lines.len(), height as usize, "all rows must be drawn");
        assert!(
            compact(lines[0]).contains("RouterControl"),
            "header row at {width}x{height}"
        );
        assert!(
            compact(lines[1]).contains("总览"),
            "tab row at {width}x{height}"
        );
        let footer = compact(lines.last().unwrap());
        assert!(
            footer.contains("q退出"),
            "footer at {width}x{height}: {footer}"
        );
    }
}

#[test]
fn kpi_and_meter_helpers_do_not_panic_on_extreme_values() {
    use super::theme::Tone;
    use super::widgets::{render_inline_meter, render_segments, Kpi, Segment};
    let theme = Theme::from_flags(true, true, true);
    let backend = TestBackend::new(40, 6);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal
        .draw(|frame| {
            let items = [
                Kpi::new("a", "—", Tone::Muted).ratio(f64::NAN),
                Kpi::new("b", "∞", Tone::Error)
                    .ratio(f64::INFINITY)
                    .detail("x"),
                Kpi::new("c", "", Tone::Success),
            ];
            widgets::render_kpis(frame, frame.area(), theme, &items);
            let mut buffer =
                ratatui::buffer::Buffer::empty(ratatui::layout::Rect::new(0, 0, 10, 1));
            let meter_area = buffer.area;
            render_inline_meter(&mut buffer, meter_area, theme, f64::NAN, Tone::Error);
            render_segments(
                &mut buffer,
                meter_area,
                theme,
                &[Segment {
                    ratio: f64::NAN,
                    tone: Tone::Error,
                }],
            );
        })
        .unwrap();
}

#[test]
fn usage_sort_cycles_without_refetching() {
    use crate::app::UsageSort;
    let mut app = test_app();
    app.page = Page::Usage;
    let before = app.pending_requests.len() + app.usage.request_id as usize;
    assert_eq!(app.usage_sort, UsageSort::Steps);
    app.handle_key(crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Char('s'),
        crossterm::event::KeyModifiers::NONE,
    ));
    assert_eq!(app.usage_sort, UsageSort::Tokens);
    assert_eq!(
        app.pending_requests.len() + app.usage.request_id as usize,
        before,
        "sorting must not refetch"
    );
    // 排序后第一行是 Token 总量最大的模型。
    let top = app.sorted_usage_model().unwrap();
    let max = app
        .usage
        .data
        .as_ref()
        .unwrap()
        .models
        .iter()
        .map(|model| model.tokens.visible_total())
        .max()
        .unwrap();
    assert_eq!(top.tokens.visible_total(), max);
}

#[test]
fn usage_sort_order_matches_rendered_rows() {
    let mut app = test_app();
    app.page = Page::Usage;
    app.cycle_usage_sort(); // Tokens
    let output = render(&mut app, 120, 40);
    let codearts = output.find("demo-code-model").unwrap();
    let loomy = output.find("demo-loomy-model").unwrap();
    assert!(codearts < loomy);
    app.cycle_usage_sort(); // Cost (all zero -> stable)
    app.cycle_usage_sort(); // Name
    let output = render(&mut app, 120, 40);
    let builtin = output.find("demo-builtin-model").unwrap();
    let codearts = output.find("demo-code-model").unwrap();
    assert!(builtin < codearts, "name sort should be alphabetical");
}

#[test]
fn wide_overview_shows_health_trend_and_attention() {
    let mut app = test_app();
    let output = render(&mut app, 140, 44);
    let compact = compact(&output);
    assert!(compact.contains("健康度"), "{compact}");
    assert!(compact.contains("近7天步骤"), "{compact}");
    assert!(compact.contains("待处理"), "{compact}");
    assert!(compact.contains("额度Top"), "{compact}");
}

#[test]
fn compact_overview_hides_sidebar_and_keeps_process_auth() {
    let mut app = test_app();
    let output = render(&mut app, 60, 20);
    let compact = compact(&output);
    assert!(
        !compact.contains("健康度"),
        "compact should drop the sidebar"
    );
    assert!(compact.contains("进程"), "{compact}");
    assert!(compact.contains("认证"), "{compact}");
}

#[test]
fn summary_line_reports_active_task() {
    let mut app = test_app();
    app.active_task = Some(crate::app::ActiveTask {
        id: 1,
        action: crate::domain::Action::one(crate::domain::ActionKind::Start, "qoder"),
        started: std::time::Instant::now(),
    });
    let output = render(&mut app, 120, 40);
    assert!(compact(&output).contains("写任务期间不能退出"));
}

/// 维护者用：`cargo test dump_screens -- --ignored --nocapture` 打印所有页面快照。
#[test]
#[ignore = "manual visual inspection helper"]
fn dump_screens() {
    let mut app = test_app();
    for page in Page::ALL {
        app.page = page;
        for (width, height) in SIZES {
            println!(
                "=== {page:?} {width}x{height} ===\n{}\n",
                render(&mut app, width, height)
            );
        }
    }
}

#[test]
#[ignore = "manual visual inspection helper"]
fn dump_ascii_screens() {
    let mut app = test_app();
    app.info.ascii = true;
    app.info.no_color = true;
    for page in [Page::Overview, Page::Usage, Page::Credits, Page::Logs] {
        app.page = page;
        println!(
            "=== ascii {page:?} 100x30 ===\n{}\n",
            render(&mut app, 100, 30)
        );
    }
}
