/**
 * useMediaQuery — SSR/jsdom-safe responsive signal. First render always
 * answers `false` (no layout dependency, deterministic tests); the real
 * match settles in the effect. The FilterBar uses it to collapse into a
 * Sheet on mobile without ever duplicating controls in the DOM.
 */
import { useEffect, useState } from 'react';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(false);

  useEffect((): (() => void) => {
    const matchMedia = globalThis.matchMedia;
    if (typeof matchMedia !== 'function') {
      // jsdom & like environments have no layout — inline rendering.
      return (): void => {};
    }
    const mql = matchMedia.call(globalThis, query);
    setMatches(mql.matches);
    const onChange = (event: MediaQueryListEvent): void => {
      setMatches(event.matches);
    };
    mql.addEventListener('change', onChange);
    return (): void => {
      mql.removeEventListener('change', onChange);
    };
  }, [query]);

  return matches;
}
