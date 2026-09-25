/**
 * Vite's `?raw` import, narrowed to the JSON fixtures the dev harness loads. The pattern is
 * deliberately more specific than `vite/client`'s own `*?raw`, so the two can coexist if the shell
 * adds that reference later.
 */
declare module "*.json?raw" {
  const content: string;
  export default content;
}
