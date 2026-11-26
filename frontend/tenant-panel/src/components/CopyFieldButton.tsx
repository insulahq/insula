import { Copy, Check } from 'lucide-react';

/** Copy to the clipboard, with the textarea fallback for a non-secure context. */
export function copyToClipboard(text: string): void {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text);
  } else {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
}

interface CopyFieldButtonProps {
  readonly field: string;
  readonly value: string;
  /** The field copied last, shown with a check for a moment. */
  readonly copiedField: string | null;
  readonly onCopy: (field: string, value: string) => void;
  readonly label?: string;
}

/** A small copy icon button; `data-testid="copy-<field>"`. */
export function CopyFieldButton({ field, value, copiedField, onCopy, label }: CopyFieldButtonProps) {
  return (
    <button
      type="button"
      onClick={() => onCopy(field, value)}
      className="shrink-0 rounded p-1 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 transition-colors"
      title={label ?? 'Copy'}
      aria-label={label ?? 'Copy'}
      data-testid={`copy-${field}`}
    >
      {copiedField === field ? (
        <Check size={14} className="text-green-500 dark:text-green-400" />
      ) : (
        <Copy size={14} />
      )}
    </button>
  );
}
