import { Check } from 'lucide-react';
import { PERMISSION_KEYS, type Permission } from '@somar/shared';
import { Button } from '@/components/ui/primitives';
import { t } from '@/i18n/ar';
import { cn } from '@/lib/utils';

/** The pages a supervisor had before permissions existed: everything (university supervisor) or scanning. */
export function effectivePermissions(role: string, permissions: string[] | null): Permission[] {
  if (permissions) return PERMISSION_KEYS.filter((k) => permissions.includes(k));
  return role === 'university_supervisor' ? [...PERMISSION_KEYS] : ['scan'];
}

/** Tick the pages a supervisor may open; two shortcuts for the common cases. */
export function PermissionPicker({ value, onChange }: { value: Permission[]; onChange: (next: Permission[]) => void }) {
  const sv = t.admin.supervisors;
  const toggle = (key: Permission) => onChange(value.includes(key) ? value.filter((k) => k !== key) : [...value, key]);
  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 text-sm font-semibold">{sv.permissions}</legend>
      <p className="text-xs text-muted">{sv.permissionsHint}</p>
      <div className="flex flex-wrap gap-3">
        <Button type="button" size="sm" variant="outline" onClick={() => onChange([...PERMISSION_KEYS])} data-testid="perm-all">
          {sv.allPages}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => onChange(['scan'])} data-testid="perm-scan-only">
          {sv.scanOnly}
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2" data-testid="perm-grid">
        {PERMISSION_KEYS.map((key) => {
          const on = value.includes(key);
          return (
            <label
              key={key}
              className={cn(
                'flex min-h-touch cursor-pointer items-center gap-3 rounded-lg border px-3 text-sm font-semibold',
                on ? 'border-brand-ink bg-brand-ink/5' : 'border-border bg-bg',
              )}
            >
              <input type="checkbox" className="sr-only" checked={on} onChange={() => toggle(key)} data-testid={`perm-${key}`} />
              <span
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded border',
                  on ? 'border-brand-ink bg-brand-ink text-on-ink' : 'border-border',
                )}
                aria-hidden
              >
                {on ? <Check className="h-3.5 w-3.5" /> : null}
              </span>
              {sv.pages[key]}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
