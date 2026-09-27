import {
  ChevronDown,
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
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { CreditFooter, InstallButton, Logo, NotificationBell, OfflineBanner, UniversityPicker } from '@/components/common';
import { AppearanceMenu } from '@/components/AppearanceMenu';
import { Button } from '@/components/ui/primitives';
import { t } from '@/i18n/ar';
import { safeStorage } from '@/lib/pwa';
import { cn } from '@/lib/utils';
import type { Permission } from '@somar/shared';
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
          <AppearanceMenu />
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
        <AppearanceMenu />
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

type NavSection = 'overview' | 'students' | 'transport' | 'field' | 'comms' | 'setup';

/** Menu sections, in order; a section with no page the user may open is hidden. */
const NAV_SECTIONS: NavSection[] = ['overview', 'students', 'transport', 'field', 'comms', 'setup'];

/** Staff menu; each page needs its permission (`adminOnly` pages are for the admin alone). */
export const ADMIN_NAV: (NavItem & { perm?: Permission; adminOnly?: boolean; section: NavSection })[] = [
  { section: 'overview', to: '/admin', label: t.nav.dashboard, icon: LayoutDashboard, end: true, perm: 'dashboard' },
  { section: 'overview', to: '/admin/stats', label: t.nav.stats, icon: BarChart3, perm: 'stats' },
  { section: 'overview', to: '/admin/pickups', label: t.nav.pickups, icon: LocateFixed, perm: 'pickups' },
  { section: 'students', to: '/admin/students', label: t.nav.students, icon: Users, perm: 'students' },
  { section: 'students', to: '/admin/import', label: t.nav.import, icon: FileSpreadsheet, perm: 'import' },
  { section: 'students', to: '/admin/packages', label: t.nav.adminPackages, icon: Package, perm: 'packages' },
  { section: 'transport', to: '/admin/routes', label: t.nav.adminRoutes, icon: Route, perm: 'routes' },
  { section: 'transport', to: '/admin/stops', label: t.nav.stops, icon: MapPinned, perm: 'routes' },
  { section: 'field', to: '/scan', label: t.nav.scan, icon: ScanLine, perm: 'scan' },
  { section: 'field', to: '/admin/scans', label: t.nav.scans, icon: QrCode, perm: 'scans' },
  { section: 'comms', to: '/admin/notifications', label: t.nav.adminNotifications, icon: Bell, perm: 'notifications' },
  { section: 'setup', to: '/admin/universities', label: t.nav.universities, icon: Building2, adminOnly: true },
  { section: 'setup', to: '/admin/colleges', label: t.nav.colleges, icon: GraduationCap, perm: 'org' },
  { section: 'setup', to: '/admin/areas', label: t.nav.areas, icon: MapPin, perm: 'org' },
  { section: 'setup', to: '/admin/supervisors', label: t.nav.supervisors, icon: BookUser, perm: 'supervisors' },
  { section: 'setup', to: '/admin/settings', label: t.nav.settings, icon: Settings, perm: 'settings' },
  { section: 'setup', to: '/admin/audit', label: t.nav.audit, icon: ClipboardList, perm: 'audit' },
];

/** The staff pages this user may open, in menu order. */
export function useAdminNav() {
  const { can, me } = useAuth();
  const isAdmin = me?.profile?.role === 'admin';
  return ADMIN_NAV.filter((item) => (item.adminOnly ? isAdmin : !item.perm || can(item.perm)));
}

const navStorage = safeStorage();
const COLLAPSED_KEY = 'somar.nav.collapsed';

/** Staff menu in titled sections; a section folds on click (remembered), the current page's section stays open. */
function SideNav({ onNavigate }: { onNavigate?: () => void }) {
  const items = useAdminNav();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set((navStorage.get(COLLAPSED_KEY) ?? '').split(',').filter(Boolean)));
  const toggle = (section: NavSection) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      navStorage.set(COLLAPSED_KEY, [...next].join(','));
      return next;
    });
  const isCurrent = (item: (typeof items)[number]) =>
    item.end ? location.pathname === item.to : location.pathname === item.to || location.pathname.startsWith(`${item.to}/`);
  return (
    <nav aria-label={t.nav.menu} className="space-y-4">
      {NAV_SECTIONS.map((section) => {
        const list = items.filter((i) => i.section === section);
        if (!list.length) return null;
        const hasCurrent = list.some(isCurrent);
        const open = hasCurrent || !collapsed.has(section);
        const id = `nav-${section}`;
        return (
          <section key={section} aria-labelledby={id}>
            <button
              type="button"
              id={id}
              aria-expanded={open}
              aria-controls={`${id}-list`}
              disabled={hasCurrent}
              onClick={() => toggle(section)}
              className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-1.5 text-xs font-extrabold uppercase tracking-wide text-muted hover:text-text disabled:cursor-default disabled:hover:text-muted"
              data-testid={id}
            >
              {t.nav.sections[section]}
              {hasCurrent ? null : <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} aria-hidden />}
            </button>
            {open ? (
              <ul id={`${id}-list`} className="mt-1 space-y-1">
                {list.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.end}
                      onClick={onNavigate}
                      className={({ isActive }) =>
                        cn(
                          'flex min-h-touch items-center gap-3 rounded-lg px-3 text-base font-semibold',
                          isActive ? 'bg-brand-ink text-on-ink' : 'text-text hover:bg-surface',
                        )
                      }
                    >
                      <item.icon className="h-5 w-5 shrink-0" aria-hidden />
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        );
      })}
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
            <AppearanceMenu />
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
        <aside className="no-print sticky top-14 hidden h-[calc(100dvh-56px)] w-72 shrink-0 overflow-y-auto border-e border-border bg-bg p-3 [scrollbar-width:thin] lg:block">
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
