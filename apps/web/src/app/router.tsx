import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Link, Navigate, Outlet, useLocation } from 'react-router-dom';
import type { Permission, Role } from '@somar/shared';
import { PushGate } from '@/components/PushGate';
import { Button } from '@/components/ui/primitives';
import { ErrorState, ListSkeleton } from '@/components/ui/states';
import { ChangePasswordPage, LoginPage, PhotoUploadPage } from '@/features/auth/AuthPages';
import { SetupPage } from '@/features/student/SetupPage';
import { PickupPage } from '@/features/student/PickupPage';
import { t } from '@/i18n/ar';
import { useAuth } from './auth';
import { AdminLayout, ScanLayout, StudentLayout, useAdminNav } from './layouts';

const StudentHome = lazy(() => import('@/features/student/StudentPages').then((m) => ({ default: m.StudentHome })));
const TripsPage = lazy(() => import('@/features/student/StudentPages').then((m) => ({ default: m.TripsPage })));
const StudentPackagesPage = lazy(() => import('@/features/student/StudentPages').then((m) => ({ default: m.PackagesPage })));
const StudentRoutesPage = lazy(() => import('@/features/student/StudentPages').then((m) => ({ default: m.RoutesPage })));
const StudentNotificationsPage = lazy(() =>
  import('@/features/student/StudentPages').then((m) => ({ default: m.NotificationsPage })),
);
const AccountPage = lazy(() => import('@/features/student/StudentPages').then((m) => ({ default: m.AccountPage })));
const ScanPage = lazy(() => import('@/features/scan/ScanPage'));
const Admin = {
  Dashboard: lazy(() => import('@/features/admin/DashboardPage')),
  Universities: lazy(() => import('@/features/admin/OrgPages').then((m) => ({ default: m.UniversitiesPage }))),
  Colleges: lazy(() => import('@/features/admin/OrgPages').then((m) => ({ default: m.CollegesPage }))),
  Areas: lazy(() => import('@/features/admin/OrgPages').then((m) => ({ default: m.AreasPage }))),
  AreaMapping: lazy(() => import('@/features/admin/OrgPages').then((m) => ({ default: m.AreaMappingPage }))),
  Packages: lazy(() => import('@/features/admin/PackagesPage')),
  Routes: lazy(() => import('@/features/admin/RoutesPage')),
  Stops: lazy(() => import('@/features/admin/StopsPage')),
  Stats: lazy(() => import('@/features/admin/StatsPage')),
  Pickups: lazy(() => import('@/features/admin/PickupsPage')),
  Students: lazy(() => import('@/features/admin/StudentsPage')),
  StudentDetail: lazy(() => import('@/features/admin/StudentDetailPage')),
  StudentForm: lazy(() => import('@/features/admin/StudentFormPage')),
  Import: lazy(() => import('@/features/admin/ImportPage')),
  Supervisors: lazy(() => import('@/features/admin/SupervisorsPage')),
  Scans: lazy(() => import('@/features/admin/ScansPage')),
  Notifications: lazy(() => import('@/features/admin/NotificationsPage')),
  Settings: lazy(() => import('@/features/admin/SettingsPage')),
  Audit: lazy(() => import('@/features/admin/AuditPage')),
};
const CardsPrintPage = lazy(() => import('@/features/cards/CardsPrintPage'));

function Page({ children }: { children: ReactNode }) {
  return <Suspense fallback={<ListSkeleton className="p-4" />}>{children}</Suspense>;
}

function FullScreenLoading() {
  return (
    <div className="mx-auto max-w-md p-6">
      <ListSkeleton rows={4} />
    </div>
  );
}

/** Session → profile → forced password change → forced photo upload → setup → mandatory notifications, in that order. */
function RequireAuth() {
  const { session, ready, me, meLoading, meError, refreshMe, signOut } = useAuth();
  const location = useLocation();
  if (!ready) return <FullScreenLoading />;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (meLoading) return <FullScreenLoading />;
  if (meError || !me) {
    return (
      <div className="mx-auto max-w-md p-6">
        <ErrorState error={meError} onRetry={() => void refreshMe()} />
      </div>
    );
  }
  if (!me.profile || !me.profile.is_active) {
    return (
      <div className="mx-auto max-w-md space-y-4 p-6 text-center">
        <ErrorState error={undefined} />
        <p className="font-semibold">{me.profile ? t.auth.suspended : t.auth.noProfile}</p>
        <Button onClick={() => void signOut()}>{t.auth.logout}</Button>
      </div>
    );
  }
  if (me.profile.must_change_password && location.pathname !== '/password') {
    return <Navigate to="/password" replace />;
  }
  if (!me.profile.must_change_password && me.student && !me.student.photo_path && location.pathname !== '/photo') {
    return <Navigate to="/photo" replace />;
  }
  if (
    !me.profile.must_change_password &&
    me.student?.photo_path &&
    !me.student.setup_completed_at &&
    !['/setup', '/password'].includes(location.pathname)
  ) {
    return <Navigate to="/setup" replace />;
  }
  if (['/password', '/photo', '/setup'].includes(location.pathname)) return <Outlet />;
  return (
    <PushGate>
      <Outlet />
    </PushGate>
  );
}

function RequireRole({ roles, student, perm }: { roles: Role[]; student?: boolean; perm?: Permission }) {
  const { me, can } = useAuth();
  const role = me?.profile?.role;
  const allowed = ((role && roles.includes(role)) || (student && me?.student)) && (!perm || can(perm));
  if (!allowed) return <Navigate to="/" replace />;
  return <Outlet />;
}

/** A staff page the user has no permission for sends them to the first page they may open. */
function Allowed({ perm, adminOnly, children }: { perm?: Permission; adminOnly?: boolean; children: ReactNode }) {
  const { me, can } = useAuth();
  const nav = useAdminNav();
  const ok = adminOnly ? me?.profile?.role === 'admin' : !perm || can(perm);
  if (ok) return <Page>{children}</Page>;
  const first = nav.find((item) => item.to !== '/admin');
  return first ? <Navigate to={first.to} replace /> : <NotFound />;
}

function HomeRedirect() {
  const { me } = useAuth();
  const role = me?.profile?.role;
  if (me?.student) return <Page><StudentHome /></Page>;
  if (role === 'admin' || role === 'university_supervisor') return <Navigate to="/admin" replace />;
  if (role === 'supervisor') return <Navigate to="/scan" replace />;
  return <Navigate to="/login" replace />;
}

function NotFound() {
  return (
    <div className="mx-auto max-w-md space-y-4 p-8 text-center">
      <p className="text-lg font-bold">{t.errors.pageNotFound}</p>
      <Button asChild variant="secondary">
        <Link to="/">{t.errors.goHome}</Link>
      </Button>
    </div>
  );
}

const STAFF: Role[] = ['admin', 'university_supervisor'];
const SCANNERS: Role[] = ['admin', 'university_supervisor', 'supervisor'];

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: '/password', element: <ChangePasswordPage /> },
      { path: '/photo', element: <PhotoUploadPage /> },
      { path: '/setup', element: <SetupPage /> },
      {
        element: <RequireRole roles={[]} student />,
        children: [
          {
            element: <StudentLayout />,
            children: [
              { path: '/trips', element: <Page><TripsPage /></Page> },
              { path: '/packages', element: <Page><StudentPackagesPage /></Page> },
              { path: '/routes', element: <Page><StudentRoutesPage /></Page> },
              { path: '/pickup', element: <Page><PickupPage /></Page> },
              { path: '/notifications', element: <Page><StudentNotificationsPage /></Page> },
              { path: '/account', element: <Page><AccountPage /></Page> },
            ],
          },
        ],
      },
      {
        element: <StudentLayout />,
        children: [{ path: '/', element: <HomeRedirect /> }],
      },
      {
        element: <RequireRole roles={SCANNERS} perm="scan" />,
        children: [{ element: <ScanLayout />, children: [{ path: '/scan', element: <Page><ScanPage /></Page> }] }],
      },
      {
        element: <RequireRole roles={STAFF} />,
        children: [
          { path: '/admin/cards', element: <Allowed perm="students"><CardsPrintPage /></Allowed> },
          {
            path: '/admin',
            element: <AdminLayout />,
            children: [
              { index: true, element: <Allowed perm="dashboard"><Admin.Dashboard /></Allowed> },
              { path: 'universities', element: <Allowed adminOnly><Admin.Universities /></Allowed> },
              { path: 'colleges', element: <Allowed perm="org"><Admin.Colleges /></Allowed> },
              { path: 'areas', element: <Allowed perm="org"><Admin.Areas /></Allowed> },
              { path: 'areas/mapping', element: <Allowed perm="org"><Admin.AreaMapping /></Allowed> },
              { path: 'packages', element: <Allowed perm="packages"><Admin.Packages /></Allowed> },
              { path: 'routes', element: <Allowed perm="routes"><Admin.Routes /></Allowed> },
              { path: 'stops', element: <Allowed perm="routes"><Admin.Stops /></Allowed> },
              { path: 'stats', element: <Allowed perm="stats"><Admin.Stats /></Allowed> },
              { path: 'pickups', element: <Allowed perm="pickups"><Admin.Pickups /></Allowed> },
              { path: 'students', element: <Allowed perm="students"><Admin.Students /></Allowed> },
              { path: 'students/new', element: <Allowed perm="students"><Admin.StudentForm /></Allowed> },
              { path: 'students/:id', element: <Allowed perm="students"><Admin.StudentDetail /></Allowed> },
              { path: 'students/:id/edit', element: <Allowed perm="students"><Admin.StudentForm /></Allowed> },
              { path: 'import', element: <Allowed perm="import"><Admin.Import /></Allowed> },
              { path: 'supervisors', element: <Allowed perm="supervisors"><Admin.Supervisors /></Allowed> },
              { path: 'scans', element: <Allowed perm="scans"><Admin.Scans /></Allowed> },
              { path: 'notifications', element: <Allowed perm="notifications"><Admin.Notifications /></Allowed> },
              { path: 'settings', element: <Allowed perm="settings"><Admin.Settings /></Allowed> },
              { path: 'audit', element: <Allowed perm="audit"><Admin.Audit /></Allowed> },
            ],
          },
        ],
      },
    ],
  },
  { path: '*', element: <NotFound /> },
], {
  future: { v7_relativeSplatPath: true, v7_fetcherPersist: true, v7_normalizeFormMethod: true, v7_partialHydration: true, v7_skipActionErrorRevalidation: true },
});
