import {
  BarChart3,
  ChartNoAxesCombined,
  Coins,
  LayoutDashboard,
  Network,
  ScrollText,
  Server,
  Settings,
  Stethoscope,
  Users,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  id: string;
  label: string;
  to: string;
  icon: LucideIcon;
  /** 网关嵌套子页（仅在网关激活时展开） */
  children?: Array<{ label: string; to: string }>;
  /** 导航分组标题（Fluent NavigationView 的分组） */
  section?: 'overview' | 'data' | 'system';
}

export const NAV_SECTIONS: Array<{ id: NonNullable<NavItem['section']>; label: string }> = [
  { id: 'overview', label: '概览' },
  { id: 'data', label: '数据' },
  { id: 'system', label: '系统' },
];

export const navItems: NavItem[] = [
  { id: 'overview', label: '总览', to: '/', icon: LayoutDashboard, section: 'overview' },
  { id: 'providers', label: '服务', to: '/providers', icon: Server, section: 'overview' },
  { id: 'quota', label: '额度', to: '/quota', icon: Coins, section: 'data' },
  { id: 'accounts', label: '账号', to: '/accounts', icon: Users, section: 'data' },
  { id: 'usage', label: '用量', to: '/usage', icon: BarChart3, section: 'data' },
  { id: 'reports', label: '报表', to: '/reports', icon: ChartNoAxesCombined, section: 'data' },
  {
    id: 'gateway',
    label: '网关',
    to: '/gateway',
    icon: Network,
    section: 'system',
    children: [
      { label: '调度', to: '/gateway' },
      { label: '网关用量', to: '/gateway/usage' },
      { label: '降级链', to: '/gateway/combos' },
      { label: '密钥', to: '/gateway/keys' },
      { label: '免费供应商', to: '/gateway/free' },
      { label: '本地应答', to: '/gateway/local-answers' },
    ],
  },
  { id: 'logs', label: '日志', to: '/logs', icon: ScrollText, section: 'system' },
  { id: 'diagnostics', label: '诊断', to: '/diagnostics', icon: Stethoscope, section: 'system' },
  { id: 'settings', label: '设置', to: '/settings', icon: Settings, section: 'system' },
];

/** 当前路径命中的导航项（用于面包屑与页面标题）。 */
export function findNavItem(pathname: string): NavItem | undefined {
  return navItems.find((n) => (n.to === '/' ? pathname === '/' : pathname.startsWith(n.to)));
}
