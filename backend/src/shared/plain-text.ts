/**
 * Text a node or another remote party supplied, made safe to show: ANSI / OSC
 * escape sequences and C0/C1 control characters removed, line breaks folded to a
 * space, length capped. A host-migration's stderr reaches the admin panel and the
 * root operator's terminal (`insula upgrade --status`); an escape sequence there
 * could repaint the screen or retitle the window while the operator decides
 * whether an upgrade is safe to continue.
 */
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const OTHER_ESC = /\x1b[@-_]/g;
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

export function plainText(s: string, max = 500): string {
  return s
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(OTHER_ESC, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(CONTROLS, '')
    .slice(0, max);
}
