import { Info } from 'lucide-react';

interface Props {
  text: string;
}

/**
 * Info-icon help hint. The text rides on a plain `title`, so the panel's global
 * tooltip layer (`<GlobalTooltips />`, mounted in main.tsx) draws it: the same
 * bubble, placement, flipping and viewport clamping as every other tooltip in
 * the panel. It used to draw its own fixed bubble, which was always centred
 * above the icon and ran off the viewport near an edge.
 */
export function Tooltip({ text }: Props) {
  return (
    <span className="inline-flex items-center" title={text} data-testid="info-tooltip">
      <Info
        size={12}
        aria-hidden="true"
        className="cursor-help text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
      />
    </span>
  );
}
