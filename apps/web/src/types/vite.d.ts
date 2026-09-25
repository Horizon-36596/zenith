/**
 * Vite's `?raw` import, which is how `examples/starter` is bundled into the app so the editor
 * demos with no folder picked, and the two stylesheet forms:
 * CSS Modules for components and a plain side-effect import for the token and base sheets.
 */
declare module "*?raw" {
  const contents: string;
  export default contents;
}

declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}

declare module "*.css";

/**
 * The slice of Vite's `import.meta.env` the app reads. The web tsconfig sets `"types": []`, so
 * `vite/client` is not pulled in wholesale. `DEV` is what review mode's fixture route needs, and
 * `BASE_URL` is the path the app is served under (`/`, or `/zenith/app/` on the public site), which
 * every URL of a file in `public/` is built from.
 */
interface ImportMetaEnv {
  readonly BASE_URL: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
  /** Vite's glob import, eager with a named import, which is the only form the app uses. */
  glob<T = unknown>(
    pattern: string,
    options: { eager: true; query?: string; import?: string },
  ): Record<string, T>;
}
