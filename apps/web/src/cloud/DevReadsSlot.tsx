/**
 * Where the development build's cloud reads readout (`DevReads.tsx`) goes. In a production build
 * `import.meta.env.DEV` is false, the lazy import below is removed with the branch it sits in, and
 * this renders nothing.
 */
import { lazy, Suspense } from "react";

const DevReads = import.meta.env.DEV ? lazy(() => import("./DevReads")) : null;

export function DevReadsSlot() {
  if (DevReads === null) return null;
  return (
    <Suspense fallback={null}>
      <DevReads />
    </Suspense>
  );
}
