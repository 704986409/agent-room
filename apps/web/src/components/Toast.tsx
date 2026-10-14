import { useEffect, useState } from 'react';

let setGlobal: ((msg: string | null) => void) | null = null;

export function showToast(msg: string) { setGlobal?.(msg); }

export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    setGlobal = setMsg;
    return () => { setGlobal = null; };
  }, []);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 1500);
    return () => clearTimeout(t);
  }, [msg]);
  if (!msg) return null;
  return (
    <div role="status" aria-live="polite" className="fixed bottom-5 right-5 bg-ink text-white text-[10px] font-medium px-4 py-2 rounded-lg shadow-lg flex items-center gap-2">
      <div className="w-3.5 h-3.5 rounded-full bg-emerald-500 text-white text-[9px] flex items-center justify-center font-bold">✓</div>
      {msg}
    </div>
  );
}
