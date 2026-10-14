import { useRef, useState, type KeyboardEvent } from 'react';
import { CODE_CHARS, CODE_LEN, CODE_SEGMENTS, CODE_SEGMENT_LEN } from '@agent-room/shared';

interface Props {
  value: string;                          // raw 9-char code (no dashes), uppercase
  onChange: (value: string) => void;      // fires on every keystroke
  onComplete?: (value: string) => void;   // fires when length hits 9
  ariaLabel?: (digit: number) => string;
}

export function CodeInput({ value, onChange, onComplete, ariaLabel }: Props) {
  const [focusIdx, setFocusIdx] = useState(0);
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  function setCharAt(i: number, c: string) {
    const up = c.toUpperCase();
    if (c && !CODE_CHARS.includes(up)) return;
    const arr = value.padEnd(CODE_LEN, ' ').split('');
    arr[i] = up;
    const next = arr.join('').trimEnd().slice(0, CODE_LEN);
    onChange(next);
    if (up && i < CODE_LEN - 1) refs.current[i + 1]?.focus();
    if (next.length === CODE_LEN) onComplete?.(next);
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>, i: number) {
    if (e.key === 'Backspace' && !value[i] && i > 0) {
      refs.current[i - 1]?.focus();
    }
  }

  const boxes: React.ReactNode[] = [];
  for (let seg = 0; seg < CODE_SEGMENTS; seg++) {
    const segBoxes = [];
    for (let j = 0; j < CODE_SEGMENT_LEN; j++) {
      const idx = seg * CODE_SEGMENT_LEN + j;
      const ch = value[idx] ?? '';
      const active = focusIdx === idx;
      segBoxes.push(
        <input
          key={idx}
          ref={el => { refs.current[idx] = el; }}
          value={ch}
          onChange={e => setCharAt(idx, e.target.value.slice(-1))}
          onFocus={() => setFocusIdx(idx)}
          onKeyDown={e => handleKey(e, idx)}
          aria-label={ariaLabel?.(idx + 1)}
          maxLength={1}
          className={`w-7 h-10 text-center font-mono font-bold text-lg rounded-md border outline-none ${active ? 'border-accent ring-4 ring-accent-tint text-accent' : 'border-border bg-surface-sunken'}`}
        />
      );
    }
    boxes.push(<div key={seg} className="flex gap-1">{segBoxes}</div>);
    if (seg < CODE_SEGMENTS - 1) {
      boxes.push(<div key={`sep-${seg}`} className="flex items-center text-ink-faint text-lg">—</div>);
    }
  }

  return <div className="flex gap-2 justify-center">{boxes}</div>;
}
