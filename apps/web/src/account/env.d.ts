/**
 * The build-time variables that turn the real cloud on (src/account/config.ts). A global script,
 * so it merges into the `ImportMetaEnv` of src/types/vite.d.ts without touching that file.
 */
interface ImportMetaEnv {
  /** The Firebase web app's config from the console, as JSON (cloud/README.md step 3). */
  readonly VITE_ZENITH_FIREBASE_CONFIG?: string;
  /** `on` offers sign-in by email link with the real cloud (spec 13 section 4.1: off in v1). */
  readonly VITE_ZENITH_EMAIL_LINK?: string;
  /**
   * The reCAPTCHA Enterprise site key registered for App Check (cloud/README.md step 7). Unset or
   * empty leaves App Check off. Setting it loads Google reCAPTCHA on every page that uses the real
   * cloud, which the privacy notice must say before a build with it ships.
   */
  readonly VITE_ZENITH_APPCHECK_SITE_KEY?: string;
  /** Where the docs are, such as `/docs/`. Unset, the public docs site (account/config.ts `DOCS_URL`). */
  readonly VITE_DOCS_URL?: string;
}
