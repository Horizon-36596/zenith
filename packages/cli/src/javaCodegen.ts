/**
 * `zenith codegen`'s generator moved to `@horizon36596/zenith-core` (`packages/core/src/codegen/`),
 * because it is pure and the editor's Code tab runs it in the browser. This module keeps the CLI's
 * imports and tests where they were.
 */
export {
  generateAutoJava,
  generateAutoJavaWithMap,
  pascalCase,
  type GeneratedJava,
  type JavaCodegenOptions as CodegenOptions,
  type JavaStepLines,
} from "@horizon36596/zenith-core";