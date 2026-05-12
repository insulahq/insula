import { useRef, useState } from 'react';
import { Info } from 'lucide-react';

interface Props {
  text: string;
}

export function Tooltip({ text }: Props) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const show = () => {
    if (!triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    setPos({ top: r.top, left: r.left + r.width / 2 });
  };

  const hide = () => setPos(null);

  return (
    <span ref={triggerRef} className="inline-flex items-center" onMouseEnter={show} onMouseLeave={hide}>
      <Info size={12} className="cursor-help text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300" />
      {pos && (
        <span
          className="pointer-events-none fixed z-[9999] w-56 rounded-md bg-gray-800 px-2.5 py-1.5 text-[11px] font-normal normal-case leading-snug tracking-normal text-white shadow-lg dark:bg-gray-700"
          style={{ top: pos.top, left: pos.left, transform: 'translate(-50%, calc(-100% - 6px))' }}
        >
          {text}
          <span className="absolute left-1/2 top-full h-0 w-0 -translate-x-1/2 border-4 border-transparent border-t-gray-800 dark:border-t-gray-700" />
        </span>
      )}
    </span>
  );
}
