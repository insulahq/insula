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
 *
 * Keyboard users reach it with Tab (the layer shows the bubble on keyboard
 * focus). It is an image named "More information" whose description is the
 * help text — not a button, because activating it does nothing, and not the
 * text itself as the name, because it often sits inside a <label> whose
 * control would otherwise be named by the whole help paragraph.
 */
export function Tooltip({ text }: Props) {
  return (
    <span
      role="img"
      aria-label="More information"
      title={text}
      tabIndex={0}
      data-testid="info-tooltip"
      className="inline-flex items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:focus-visible:ring-blue-400"
    >
      <Info
        size={12}
        aria-hidden="true"
        className="cursor-help text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
      />
    </span>
  );
}
