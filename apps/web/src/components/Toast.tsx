import { useEffect, useState } from 'react';

export type ToastVariant = 'success' | 'error' | 'info';

interface Toast { msg: string; variant: ToastVariant }

let setGlobal: ((toast: Toast | null) => void) | null = null;

// Callers that pass only a message mean "it worked" — that was the single
// look this host had, so success stays the default.
export function showToast(msg: string, variant: ToastVariant = 'success') { setGlobal?.({ msg, variant }); }

const VARIANTS: Record<ToastVariant, {
  icon: string;
  role: 'alert' | 'status';
  ariaLive: 'assertive' | 'polite';
  boxClassName: string;
  iconClassName: string;
}> = {
  success: {
    icon: '✓',
    role: 'status',
    ariaLive: 'polite',
    boxClassName: 'bg-ink text-white',
    iconClassName: 'bg-emerald-500 text-white',
  },
  error: {
    icon: '✕',
    role: 'alert',
    ariaLive: 'assertive',
    boxClassName: 'bg-red-600 text-white',
    iconClassName: 'bg-white text-red-600',
  },
  info: {
    icon: 'i',
    role: 'status',
    ariaLive: 'polite',
    boxClassName: 'bg-ink text-white',
    iconClassName: 'bg-slate-400 text-white',
  },
};

export function ToastHost() {
  const [toast, setToast] = useState<Toast | null>(null);
  useEffect(() => {
    setGlobal = setToast;
    return () => { setGlobal = null; };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1500);
    return () => clearTimeout(t);
  }, [toast]);
  if (!toast) return null;
  const variant = VARIANTS[toast.variant] ?? VARIANTS.success;
  return (
    <div
      role={variant.role}
      aria-live={variant.ariaLive}
      data-variant={toast.variant}
      className={`fixed bottom-5 right-5 ${variant.boxClassName} text-[10px] font-medium px-4 py-2 rounded-lg shadow-lg flex items-center gap-2`}
    >
      <div className={`w-3.5 h-3.5 rounded-full ${variant.iconClassName} text-[9px] flex items-center justify-center font-bold`}>{variant.icon}</div>
      {toast.msg}
    </div>
  );
}
