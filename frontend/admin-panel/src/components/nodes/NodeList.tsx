import { Fragment } from 'react';
import NodeName from './NodeName';

/** Several nodes, comma-separated, each by its alias (Kubernetes name on hover). */
export default function NodeList({ names, separator = ', ' }: { readonly names: readonly string[]; readonly separator?: string }) {
  return (
    <>
      {names.map((n, i) => (
        <Fragment key={`${i}:${n}`}>
          {i > 0 && separator}
          <NodeName name={n} />
        </Fragment>
      ))}
    </>
  );
}
