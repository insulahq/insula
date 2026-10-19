import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Open the item a link named — `?mailbox=<id>` — once the list holding it has
 * loaded, then drop the parameter so closing the dialog does not reopen it.
 *
 * The admin panel links into this panel this way ("Login as tenant" lands on
 * `next`), so an operator reaches the one mailbox or list a row was about
 * instead of the page that holds it. An id the list does not contain is
 * dropped silently: the page itself is still the right place to be.
 */
export function useOpenFromQuery<T extends { readonly id: string }>(
  param: string,
  items: readonly T[] | undefined,
  open: (item: T) => void,
): void {
  const [searchParams, setSearchParams] = useSearchParams();
  const wanted = searchParams.get(param);
  useEffect(() => {
    if (!wanted || items === undefined) return;
    const item = items.find((i) => i.id === wanted);
    if (item) open(item);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete(param);
      return next;
    }, { replace: true });
    // `open` is left out of the dependencies on purpose: it is a state setter
    // or a fresh closure each render; the id and the list decide whether there
    // is anything to open.
  }, [wanted, items, param, setSearchParams]);
}
