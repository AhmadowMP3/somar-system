import { Slot } from '@radix-ui/react-slot';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ComponentPropsWithoutRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-colors min-h-touch px-4 disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-ink/30',
  {
    variants: {
      variant: {
        primary: 'bg-brand text-white hover:bg-brand-dark',
        secondary: 'bg-brand-ink text-white hover:bg-black',
        outline: 'border border-border bg-bg text-text hover:bg-surface',
        ghost: 'text-text hover:bg-surface',
        danger: 'bg-danger text-white hover:bg-brand-dark',
        success: 'bg-success text-white hover:opacity-90',
        link: 'text-brand-ink underline-offset-4 hover:underline min-h-0 px-0',
      },
      size: {
        sm: 'min-h-[36px] px-3 text-xs',
        md: '',
        lg: 'min-h-[56px] px-6 text-base',
        icon: 'px-0 w-11',
      },
    },
    defaultVariants: { variant: 'outline', size: 'md' },
  },
);

export type ButtonProps = ComponentPropsWithoutRef<'button'> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, type, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        type={asChild ? undefined : (type ?? 'button')}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

const fieldBase =
  'w-full rounded-lg border border-border bg-bg px-3 text-base text-text placeholder:text-muted focus:outline-none focus:ring-4 focus:ring-brand-ink/15 focus:border-brand-ink disabled:bg-surface disabled:text-muted';

export const Input = forwardRef<HTMLInputElement, ComponentPropsWithoutRef<'input'>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(fieldBase, 'min-h-touch', className)} {...props} />
));
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, ComponentPropsWithoutRef<'textarea'>>(
  ({ className, ...props }, ref) => <textarea ref={ref} className={cn(fieldBase, 'min-h-[88px] py-2', className)} {...props} />,
);
Textarea.displayName = 'Textarea';

export const Select = forwardRef<HTMLSelectElement, ComponentPropsWithoutRef<'select'>>(({ className, ...props }, ref) => (
  <select ref={ref} className={cn(fieldBase, 'min-h-touch pe-8', className)} {...props} />
));
Select.displayName = 'Select';

export function Label({ className, ...props }: ComponentPropsWithoutRef<'label'>) {
  return <label className={cn('mb-1 block text-sm font-semibold text-text', className)} {...props} />;
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
      {error ? (
        <p className="text-xs font-semibold text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-xl border border-border bg-bg p-4 shadow-sm', className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('mb-3 text-base font-bold text-text', className)} {...props} />;
}

const badgeVariants = cva('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold', {
  variants: {
    tone: {
      neutral: 'bg-surface text-brand-ink border border-border',
      success: 'bg-success/10 text-success',
      danger: 'bg-danger/10 text-danger',
      warning: 'bg-warning/10 text-warning',
      info: 'bg-brand-ink/10 text-brand-ink',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export function Badge({
  className,
  tone,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-lg bg-surface', className)} aria-hidden {...props} />;
}

export const Switch = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      'peer inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-ink/30 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-success data-[state=unchecked]:bg-brand-silver',
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb className="pointer-events-none block h-6 w-6 rounded-full bg-white shadow-lg transition-transform data-[state=checked]:-translate-x-5 data-[state=unchecked]:translate-x-0" />
  </SwitchPrimitive.Root>
));
Switch.displayName = 'Switch';
