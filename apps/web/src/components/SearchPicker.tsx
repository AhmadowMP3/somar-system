import { Check, ChevronDown, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { foldArabic } from '@somar/shared';
import { cn } from '@/lib/utils';
import { Input } from './ui/primitives';

export type PickerItem = { id: string; name: string };

/**
 * Search-as-you-type single choice (combobox). The list opens when the field is focused or typed in,
 * and closes after a choice, on Escape, or on a tap outside; the chosen name then shows in the field.
 * Arabic spelling variants are folded (أ/ا، ة/ه، ى/ي).
 */
export function SearchPicker({
  items,
  value,
  onChange,
  placeholder,
  label,
  emptyText,
  testId,
}: {
  items: PickerItem[];
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
  label: string;
  emptyText: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const selected = items.find((i) => i.id === value);
  const needle = foldArabic(term);
  const matches = needle ? items.filter((i) => foldArabic(i.name).includes(needle)) : items;

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) close();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  function close() {
    setOpen(false);
    setTerm('');
  }

  function pick(id: string) {
    onChange(id);
    close();
    input.current?.blur();
  }

  return (
    <div ref={root} className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-muted" aria-hidden />
        <Input
          ref={input}
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          value={open ? term : (selected?.name ?? '')}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setTerm(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            if (e.key === 'Enter') {
              e.preventDefault();
              if (open && matches.length === 1 && matches[0]) pick(matches[0].id);
            }
          }}
          placeholder={open && selected ? selected.name : placeholder}
          className={cn('pe-9 ps-9', !open && selected && 'font-semibold')}
          data-testid={testId ? `${testId}-search` : undefined}
        />
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          className="absolute inset-y-0 end-0 flex w-9 items-center justify-center text-muted"
          onClick={() => (open ? close() : input.current?.focus())}
        >
          <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} />
        </button>
      </div>
      {open ? (
        <ul
          role="listbox"
          aria-label={label}
          className="max-h-60 overflow-y-auto rounded-lg border border-border bg-bg shadow-sm"
          data-testid={testId ? `${testId}-options` : undefined}
        >
          {matches.length ? (
            matches.map((item) => (
              <li key={item.id} role="option" aria-selected={item.id === value}>
                <button
                  type="button"
                  onClick={() => pick(item.id)}
                  className={cn(
                    'flex min-h-touch w-full items-center justify-between gap-2 px-3 text-start',
                    item.id === value ? 'bg-brand-ink text-on-ink' : 'hover:bg-surface',
                  )}
                >
                  <span>{item.name}</span>
                  {item.id === value ? <Check className="h-4 w-4" aria-hidden /> : null}
                </button>
              </li>
            ))
          ) : (
            <li className="px-3 py-3 text-sm text-muted">{emptyText}</li>
          )}
        </ul>
      ) : null}
    </div>
  );
}
