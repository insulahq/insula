import { useNodeText } from '@/hooks/use-node-labels';

/**
 * Free text from the server — a probe detail, an error, a reason — with every
 * aliased node name shown by its alias. For a bare node name use `NodeName`.
 */
export default function NodeText({ text }: { readonly text: string | null | undefined }) {
  return <>{useNodeText()(text)}</>;
}
