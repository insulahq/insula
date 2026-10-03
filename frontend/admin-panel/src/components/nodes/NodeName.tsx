import { useNodeLabel } from '@/hooks/use-node-labels';

/**
 * A node, by the name operators gave it. Shows the alias when one is set and
 * keeps the Kubernetes name in the tooltip — the name to type in a terminal or
 * look up in `kubectl` is still one hover away.
 */
export default function NodeName({ name, className }: { readonly name: string | null | undefined; readonly className?: string }) {
  const label = useNodeLabel()(name);
  if (!name) return null;
  if (label === name) return className ? <span className={className}>{name}</span> : <>{name}</>;
  return <span className={className} title={name}>{label}</span>;
}
