import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Link, Navigate, Outlet, useLocation } from 'react-router-dom';
import type { Role } from '@somar/shared';
import { Button } from '@/components/ui/primitives';
import { ErrorState, ListSkeleton } from '@/components/ui/states';
import { ChangePasswordPage, LoginPage, PhotoUploadPage } from '@/features/auth/AuthPages';
import { t } from '@/i18n/ar';
import { useAuth } from './auth';
import { AdminLayout, ScanLayout, StudentLayout } from './layouts';

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

/** Session → profile → forced password change → forced photo upload, in that order. */
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
  return <Outlet />;
}

function RequireRole({ roles, student }: { roles: Role[]; student?: boolean }) {
  const { me } = useAuth();
  const role = me?.profile?.role;
  const allowed = (role && roles.includes(role)) || (student && me?.student);
  if (!allowed) return <Navigate to="/" replace />;
  return <Outlet />;
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
      {
        element: <RequireRole roles={[]} student />,
        children: [
          {
            element: <StudentLayout />,
            children: [
              { path: '/trips', element: <Page><TripsPage /></Page> },
              { path: '/packages', element: <Page><StudentPackagesPage /></Page> },
              { path: '/routes', element: <Page><StudentRoutesPage /></Page> },
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
        element: <RequireRole roles={SCANNERS} />,
        children: [{ element: <ScanLayout />, children: [{ path: '/scan', element: <Page><ScanPage /></Page> }] }],
      },
      {
        element: <RequireRole roles={STAFF} />,
        children: [
          { path: '/admin/cards', element: <Page><CardsPrintPage /></Page> },
          {
            path: '/admin',
            element: <AdminLayout />,
            children: [
              { index: true, element: <Page><Admin.Dashboard /></Page> },
              { path: 'universities', element: <Page><Admin.Universities /></Page> },
              { path: 'colleges', element: <Page><Admin.Colleges /></Page> },
              { path: 'areas', element: <Page><Admin.Areas /></Page> },
              { path: 'areas/mapping', element: <Page><Admin.AreaMapping /></Page> },
              { path: 'packages', element: <Page><Admin.Packages /></Page> },
              { path: 'routes', element: <Page><Admin.Routes /></Page> },
              { path: 'students', element: <Page><Admin.Students /></Page> },
              { path: 'students/new', element: <Page><Admin.StudentForm /></Page> },
              { path: 'students/:id', element: <Page><Admin.StudentDetail /></Page> },
              { path: 'students/:id/edit', element: <Page><Admin.StudentForm /></Page> },
              { path: 'import', element: <Page><Admin.Import /></Page> },
              { path: 'supervisors', element: <Page><Admin.Supervisors /></Page> },
              { path: 'scans', element: <Page><Admin.Scans /></Page> },
              { path: 'notifications', element: <Page><Admin.Notifications /></Page> },
              { path: 'settings', element: <Page><Admin.Settings /></Page> },
              { path: 'audit', element: <Page><Admin.Audit /></Page> },
            ],
          },
        ],
      },
    ],
  },
  { path: '*', element: <NotFound /> },
]);
