import { Check, Monitor, Moon, Sun, Type } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { t } from '@/i18n/ar';
import { useAppearance, type TextSize, type ThemeMode } from '@/lib/appearance';
import { cn } from '@/lib/utils';
import { Dialog } from './ui/overlay';
import { Button } from './ui/primitives';

function Choice({ selected, onClick, icon, label, testId }: { selected: boolean; onClick: () => void; icon: ReactNode; label: string; testId: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        'flex min-h-[64px] flex-1 flex-col items-center justify-center gap-1 rounded-xl border-2 px-3 py-2 text-base font-bold transition-colors',
        selected ? 'border-brand bg-brand/10 text-text' : 'border-border bg-bg hover:bg-surface',
      )}
    >
      <span className="flex items-center gap-1">
        {icon}
        {selected ? <Check className="h-4 w-4 text-brand" aria-hidden /> : null}
      </span>
      {label}
    </button>
  );
}

/** Theme (light / dark / follow the device) and text size, per device. */
export function AppearanceMenu({ className }: { className?: string }) {
  const a = t.appearance;
  const [open, setOpen] = useState(false);
  const { theme, text, setTheme, setText } = useAppearance();
  const themes: { value: ThemeMode; label: string; icon: ReactNode }[] = [
    { value: 'light', label: a.light, icon: <Sun className="h-6 w-6" aria-hidden /> },
    { value: 'dark', label: a.dark, icon: <Moon className="h-6 w-6" aria-hidden /> },
    { value: 'system', label: a.system, icon: <Monitor className="h-6 w-6" aria-hidden /> },
  ];
  const sizes: { value: TextSize; label: string; icon: ReactNode }[] = [
    { value: 'normal', label: a.normal, icon: <Type className="h-5 w-5" aria-hidden /> },
    { value: 'large', label: a.large, icon: <Type className="h-7 w-7" aria-hidden /> },
  ];
  return (
    <>
      <Button variant="ghost" size="icon" className={className} aria-label={a.title} onClick={() => setOpen(true)} data-testid="appearance">
        {theme === 'dark' ? <Moon className="h-5 w-5" /> : theme === 'light' ? <Sun className="h-5 w-5" /> : <Monitor className="h-5 w-5" />}
      </Button>
      <Dialog open={open} onOpenChange={setOpen} title={a.title}>
        <div className="space-y-5">
          <section>
            <p className="mb-2 font-bold">{a.theme}</p>
            <div role="radiogroup" aria-label={a.theme} className="flex gap-3">
              {themes.map((x) => (
                <Choice key={x.value} selected={theme === x.value} onClick={() => setTheme(x.value)} icon={x.icon} label={x.label} testId={`theme-${x.value}`} />
              ))}
            </div>
          </section>
          <section>
            <p className="mb-2 font-bold">{a.textSize}</p>
            <div role="radiogroup" aria-label={a.textSize} className="flex gap-3">
              {sizes.map((x) => (
                <Choice key={x.value} selected={text === x.value} onClick={() => setText(x.value)} icon={x.icon} label={x.label} testId={`text-${x.value}`} />
              ))}
            </div>
          </section>
        </div>
      </Dialog>
    </>
  );
}
