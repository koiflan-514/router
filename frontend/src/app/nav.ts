import {
  BarChart3,
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
}

export const navItems: NavItem[] = [
  { id: 'overview', label: '总览', to: '/', icon: LayoutDashboard },
  { id: 'providers', label: '服务', to: '/providers', icon: Server },
  { id: 'quota', label: '额度', to: '/quota', icon: Coins },
  { id: 'accounts', label: '账号', to: '/accounts', icon: Users },
  { id: 'logs', label: '日志', to: '/logs', icon: ScrollText },
  { id: 'diagnostics', label: '诊断', to: '/diagnostics', icon: Stethoscope },
  { id: 'usage', label: '用量', to: '/usage', icon: BarChart3 },
  {
    id: 'gateway',
    label: '网关',
    to: '/gateway',
    icon: Network,
    children: [
      { label: '调度', to: '/gateway' },
      { label: '网关用量', to: '/gateway/usage' },
      { label: '降级链', to: '/gateway/combos' },
      { label: '密钥', to: '/gateway/keys' },
      { label: '免费供应商', to: '/gateway/free' },
      { label: '本地应答', to: '/gateway/local-answers' },
    ],
  },
  { id: 'settings', label: '设置', to: '/settings', icon: Settings },
];
