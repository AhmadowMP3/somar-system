import {
  BarChart3,
  LocateFixed,
  Bell,
  BookUser,
  Building2,
  ClipboardList,
  FileSpreadsheet,
  GraduationCap,
  History,
  Home,
  LayoutDashboard,
  LogOut,
  MapPin,
  MapPinned,
  Menu,
  Package,
  QrCode,
  Route,
  ScanLine,
  Settings,
  User,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { CreditFooter, InstallButton, Logo, NotificationBell, OfflineBanner, UniversityPicker } from '@/components/common';
import { Button } from '@/components/ui/primitives';
import { t } from '@/i18n/ar';
import { cn } from '@/lib/utils';
import { useAuth } from './auth';

type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean };

function BottomTabs({ items }: { items: NavItem[] }) {
  return (
    <nav
      aria-label={t.nav.menu}
      className="no-print fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg/95 backdrop-blur safe-bottom"
    >
      <ul className="mx-auto flex max-w-2xl">
        {items.map((item) => (
          <li key={item.to} className="flex-1">
            <NavLink
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  'flex min-h-[56px] flex-col items-center justify-center gap-0.5 text-[11px] font-semibold',
                  isActive ? 'text-brand' : 'text-muted',
                )
              }
            >
              <item.icon className="h-6 w-6" aria-hidden />
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function TopBar({ children }: { children?: ReactNode }) {
  return (
    <header className="no-print sticky top-0 z-30 border-b border-border bg-bg/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-2xl items-center justify-between gap-2 px-4">{children}</div>
    </header>
  );
}

/** Student (and promoted student-supervisor) shell with a bottom tab bar. */
export function StudentLayout() {
  const { canScan } = useAuth();
  const items: NavItem[] = [
    { to: '/', label: t.nav.home, icon: Home, end: true },
    { to: '/trips', label: t.nav.trips, icon: History },
    ...(canScan ? [{ to: '/scan', label: t.nav.scanShort, icon: ScanLine }] : []),
    { to: '/routes', label: t.nav.routesShort, icon: Route },
    { to: '/account', label: t.nav.account, icon: User },
  ];
  return (
    <div className="min-h-dvh pb-20">
      <OfflineBanner />
      <TopBar>
        <Logo />
        <div className="flex items-center gap-2">
          <InstallButton />
          <NotificationBell to="/notifications" />
        </div>
      </TopBar>
      <main className="mx-auto max-w-2xl px-4 py-4">
        <Outlet />
        <CreditFooter />
      </main>
      <BottomTabs items={items} />
    </div>
  );
}

/** Scanner shell: standalone supervisors see only scan; staff get a link back to admin. */
export function ScanLayout() {
  const { isStudent, isStaff, signOut } = useAuth();
  const navigate = useNavigate();
  const items: NavItem[] = isStudent
    ? [
        { to: '/', label: t.nav.home, icon: Home, end: true },
        { to: '/scan', label: t.nav.scanShort, icon: ScanLine },
        { to: '/account', label: t.nav.account, icon: User },
      ]
    : [
        { to: '/scan', label: t.nav.scanShort, icon: ScanLine },
        ...(isStaff ? [{ to: '/admin', label: t.nav.admin, icon: LayoutDashboard }] : []),
        { to: '/password', label: t.nav.password, icon: User },
      ];
  return (
    <div className="min-h-dvh pb-20">
      <OfflineBanner />
      <TopBar>
        <Logo />
        <InstallButton className="ms-auto" />
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            await signOut();
            navigate('/login', { replace: true });
          }}
        >
          <LogOut className="h-4 w-4" aria-hidden />
          {t.auth.logout}
        </Button>
      </TopBar>
      <main className="mx-auto max-w-2xl px-4 py-4">
        <Outlet />
        <CreditFooter />
      </main>
      <BottomTabs items={items} />
    </div>
  );
}

const ADMIN_NAV: NavItem[] = [
  { to: '/admin', label: t.nav.dashboard, icon: LayoutDashboard, end: true },
  { to: '/admin/universities', label: t.nav.universities, icon: Building2 },
  { to: '/admin/colleges', label: t.nav.colleges, icon: GraduationCap },
  { to: '/admin/areas', label: t.nav.areas, icon: MapPin },
  { to: '/admin/packages', label: t.nav.adminPackages, icon: Package },
  { to: '/admin/stops', label: t.nav.stops, icon: MapPinned },
  { to: '/admin/routes', label: t.nav.adminRoutes, icon: Route },
  { to: '/admin/students', label: t.nav.students, icon: Users },
  { to: '/admin/import', label: t.nav.import, icon: FileSpreadsheet },
  { to: '/admin/supervisors', label: t.nav.supervisors, icon: BookUser },
  { to: '/admin/stats', label: t.nav.stats, icon: BarChart3 },
  { to: '/admin/pickups', label: t.nav.pickups, icon: LocateFixed },
  { to: '/admin/scans', label: t.nav.scans, icon: QrCode },
  { to: '/admin/notifications', label: t.nav.adminNotifications, icon: Bell },
  { to: '/admin/settings', label: t.nav.settings, icon: Settings },
  { to: '/admin/audit', label: t.nav.audit, icon: ClipboardList },
  { to: '/scan', label: t.nav.scan, icon: ScanLine },
];

function SideNav({ onNavigate }: { onNavigate?: () => void }) {
  const items = ADMIN_NAV;
  return (
    <nav aria-label={t.nav.menu}>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.end}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  'flex min-h-touch items-center gap-3 rounded-lg px-3 text-sm font-semibold',
                  isActive ? 'bg-brand-ink text-white' : 'text-text hover:bg-surface',
                )
              }
            >
              <item.icon className="h-5 w-5" aria-hidden />
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function AdminLayout() {
  const { me, signOut } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const logout = async () => {
    await signOut();
    navigate('/login', { replace: true });
  };
  return (
    <div className="min-h-dvh bg-surface">
      <OfflineBanner />
      <header className="no-print sticky top-0 z-30 border-b border-border bg-bg">
        <div className="flex h-14 items-center gap-2 px-3 lg:px-6">
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label={t.nav.menu} onClick={() => setOpen(true)}>
            <Menu className="h-6 w-6" />
          </Button>
          <Logo className="h-8" />
          <div className="ms-auto flex items-center gap-2">
            <InstallButton />
            <UniversityPicker className="hidden sm:block" />
            <NotificationBell to="/admin/notifications" />
            <span className="hidden text-sm text-muted md:inline">
              {me?.profile?.full_name} · {t.roles[me?.profile?.role ?? ''] ?? ''}
            </span>
            <Button variant="ghost" size="icon" aria-label={t.auth.logout} onClick={logout}>
              <LogOut className="h-5 w-5" />
            </Button>
          </div>
        </div>
        <div className="border-t border-border px-3 py-2 sm:hidden">
          <UniversityPicker className="w-full max-w-none" />
        </div>
      </header>
      <div className="flex">
        <aside className="no-print sticky top-14 hidden h-[calc(100dvh-56px)] w-64 shrink-0 overflow-y-auto border-e border-border bg-bg p-3 lg:block">
          <SideNav />
        </aside>
        {open ? (
          <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label={t.nav.menu}>
            <button type="button" className="absolute inset-0 bg-black/40" aria-label={t.common.close} onClick={() => setOpen(false)} />
            <div className="absolute inset-y-0 start-0 w-72 overflow-y-auto bg-bg p-3 shadow-xl">
              <div className="mb-3 flex items-center justify-between">
                <Logo />
                <Button variant="ghost" size="icon" aria-label={t.common.close} onClick={() => setOpen(false)}>
                  <X className="h-5 w-5" />
                </Button>
              </div>
              <SideNav onNavigate={() => setOpen(false)} />
            </div>
          </div>
        ) : null}
        <main className="min-w-0 flex-1 p-4 lg:p-6">
          <Outlet />
          <CreditFooter className="mt-6" />
        </main>
      </div>
    </div>
  );
}
