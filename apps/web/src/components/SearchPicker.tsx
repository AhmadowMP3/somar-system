import { Check, Search } from 'lucide-react';
import { useState } from 'react';
import { foldArabic } from '@somar/shared';
import { cn } from '@/lib/utils';
import { Input } from './ui/primitives';

export type PickerItem = { id: string; name: string };

/** Search-as-you-type single choice list. Arabic spelling variants are folded (أ/ا، ة/ه، ى/ي). */
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
  const [term, setTerm] = useState('');
  const needle = foldArabic(term);
  const matches = needle ? items.filter((i) => foldArabic(i.name).includes(needle)) : items;
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-muted" aria-hidden />
        <Input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="ps-9"
          data-testid={testId ? `${testId}-search` : undefined}
        />
      </div>
      <ul
        role="listbox"
        aria-label={label}
        className="max-h-60 overflow-y-auto rounded-lg border border-border"
        data-testid={testId ? `${testId}-options` : undefined}
      >
        {matches.length ? (
          matches.map((item) => (
            <li key={item.id} role="option" aria-selected={item.id === value}>
              <button
                type="button"
                onClick={() => onChange(item.id)}
                className={cn(
                  'flex min-h-touch w-full items-center justify-between gap-2 px-3 text-start',
                  item.id === value ? 'bg-brand-ink text-white' : 'hover:bg-surface',
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
    </div>
  );
}
