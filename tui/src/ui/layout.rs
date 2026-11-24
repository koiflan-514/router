//! 响应式断点与布局骨架。
//!
//! 断点（宽度）：
//! - `>= 120`：宽屏，三栏仪表盘（主区 + 右栏，右栏再分上下）。
//! - `80..=119`：单栏，信息分层（KPI → 主区 → 摘要）。
//! - `< 80`：紧凑，只保留关键列，隐藏说明文字。
//!
//! 高度优先级：KPI 条与主表格永远保留；高度不足时先压缩说明文字，再压缩卡片。
//! 所有 `split` 都保证返回的 `Rect` 非负，调用方不需要再判空。

use ratatui::layout::{Constraint, Layout, Rect};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Breakpoint {
    /// 宽屏三栏/双栏仪表盘。
    Wide,
    /// 单栏但分层。
    Standard,
    /// 紧凑：只保留关键列。
    Compact,
}

impl Breakpoint {
    pub fn of(width: u16) -> Self {
        if width >= 120 {
            Self::Wide
        } else if width >= 80 {
            Self::Standard
        } else {
            Self::Compact
        }
    }

    pub fn is_wide(self) -> bool {
        self == Self::Wide
    }

    pub fn is_compact(self) -> bool {
        self == Self::Compact
    }

    /// 是否显示说明性文字（窄屏优先砍掉）。
    pub fn shows_notes(self) -> bool {
        self != Self::Compact
    }

    /// 右栏宽度比例。
    pub fn sidebar_width(self, total: u16) -> u16 {
        match self {
            Self::Wide => (total * 34 / 100).clamp(32, 56),
            Self::Standard => 0,
            Self::Compact => 0,
        }
    }
}

/// 应用外壳：顶栏 1 行 + 页签 1 行 + 主内容 + 摘要 1 行 + footer 1 行。
pub struct Shell {
    pub header: Rect,
    pub tabs: Rect,
    pub body: Rect,
    pub summary: Rect,
    pub footer: Rect,
}

impl Shell {
    pub fn split(area: Rect) -> Self {
        // 高度不足 12 时上层已经显示「终端过小」提示，这里仍保证结构完整。
        let chunks = Layout::vertical([
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Min(3),
            Constraint::Length(1),
            Constraint::Length(1),
        ])
        .split(area);
        Self {
            header: chunks[0],
            tabs: chunks[1],
            body: chunks[2],
            summary: chunks[3],
            footer: chunks[4],
        }
    }
}

/// 主区 + 右栏。窄屏时右栏为 `None`。
pub fn split_sidebar(area: Rect, breakpoint: Breakpoint) -> (Rect, Option<Rect>) {
    if !breakpoint.is_wide() {
        return (area, None);
    }
    let sidebar = breakpoint.sidebar_width(area.width);
    let chunks = Layout::horizontal([Constraint::Min(40), Constraint::Length(sidebar)])
        .spacing(1)
        .split(area);
    (chunks[0], Some(chunks[1]))
}

/// KPI 条 + 剩余内容。高度不足时 KPI 压到 1 行。
pub fn split_kpi(area: Rect, desired_height: u16) -> (Rect, Rect) {
    let kpi_height = desired_height.min(area.height.saturating_sub(4)).max(1);
    let chunks = Layout::vertical([Constraint::Length(kpi_height), Constraint::Min(1)]).split(area);
    (chunks[0], chunks[1])
}

/// 横向等分，`n` 个子区。
pub fn columns(area: Rect, n: usize) -> Vec<Rect> {
    if n == 0 {
        return Vec::new();
    }
    let constraints = vec![Constraint::Ratio(1, n as u32); n];
    Layout::horizontal(constraints).split(area).to_vec()
}

/// 居中弹窗。宽度按百分比，高度按行数，均夹到可视区域内。
pub fn popup(area: Rect, width_percent: u16, height_lines: u16, max_width: u16) -> Rect {
    let width = area
        .width
        .saturating_mul(width_percent)
        .saturating_div(100)
        .min(max_width)
        .min(area.width.saturating_sub(2))
        .max(area.width.min(30));
    let height = height_lines
        .saturating_add(2)
        .min(area.height.saturating_sub(2))
        .max(area.height.min(7));
    Rect {
        x: area.x + area.width.saturating_sub(width) / 2,
        y: area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn breakpoints_match_documented_columns() {
        assert_eq!(Breakpoint::of(160), Breakpoint::Wide);
        assert_eq!(Breakpoint::of(120), Breakpoint::Wide);
        assert_eq!(Breakpoint::of(119), Breakpoint::Standard);
        assert_eq!(Breakpoint::of(80), Breakpoint::Standard);
        assert_eq!(Breakpoint::of(79), Breakpoint::Compact);
        assert!(!Breakpoint::Compact.shows_notes());
    }

    #[test]
    fn shell_rows_always_fit_the_area() {
        for (width, height) in [(160, 48), (120, 40), (100, 30), (80, 24), (60, 20)] {
            let area = Rect::new(0, 0, width, height);
            let shell = Shell::split(area);
            assert_eq!(shell.header.height, 1);
            assert_eq!(shell.tabs.height, 1);
            assert_eq!(shell.footer.height, 1);
            assert!(shell.body.height >= 3);
            assert!(shell.body.bottom() <= area.bottom());
        }
    }

    #[test]
    fn sidebar_only_exists_on_wide_screens() {
        let wide = Rect::new(0, 0, 140, 40);
        let (main, sidebar) = split_sidebar(wide, Breakpoint::Wide);
        let sidebar = sidebar.expect("wide layout has a sidebar");
        assert!(sidebar.width >= 32);
        assert!(main.width + sidebar.width < wide.width);

        let narrow = Rect::new(0, 0, 100, 30);
        let (main, sidebar) = split_sidebar(narrow, Breakpoint::Standard);
        assert_eq!(main, narrow);
        assert!(sidebar.is_none());
    }

    #[test]
    fn popup_never_exceeds_area() {
        let area = Rect::new(0, 0, 60, 20);
        let popup = popup(area, 90, 40, 100);
        assert!(popup.right() <= area.right());
        assert!(popup.bottom() <= area.bottom());
        assert!(popup.width >= 30);
    }

    #[test]
    fn column_splits_cover_the_area() {
        let area = Rect::new(2, 3, 80, 24);
        let parts = columns(area, 3);
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].x, area.x);
        assert_eq!(parts.last().unwrap().right(), area.right());
    }
}
