/**
 * Extension-loader parity with Pi's shipped runtimes.
 */

/**
 * Environment variable jiti reads when it decides whether to try the runtime's
 * native require/import before applying its own transform.
 * @internal
 */
const JITI_TRY_NATIVE = "JITI_TRY_NATIVE";

/** Nesting depth of `withoutJitiNativeImport` calls in this process. */
let suppressionDepth = 0;

/**
 * Run `fn` with jiti's native import/require fast-path disabled.
 *
 * **Why this exists**: Pi loads every extension entrypoint through jiti
 * (`loadExtensionModule` in `core/extensions/loader.ts`). Which jiti options it
 * passes depends on how Pi itself is running:
 *
 * ```ts
 * isBunBinary || isNodeSeaBinary || isBundledNode
 *   ? { virtualModules, tryNative: false } // compiled binary / bundled Node
 *   : isTypeScriptSourceRuntime
 *     ? { virtualModules, tsconfigPaths: true }
 *     : { alias: getAliases() } // unbundled Node build
 * ```
 *
 * The last branch — the one an in-process harness always takes, because it
 * imports the package's compiled entrypoint — leaves `tryNative` at jiti's
 * default, and that default is "enabled if Bun is detected". Under a Bun test
 * runner this combination hands Pi a factory for a module whose body has not
 * finished evaluating: an entrypoint with a module-level `await import(...)`
 * reports as loaded before its top-level `const` is initialized, so the hoisted
 * default export Pi calls throws `Cannot access 'x' before initialization`.
 *
 * Pi's shipped runtimes never take that path, so the harness pins the choice
 * they make (`tryNative: false`) for the duration of the load. This keeps
 * `extensionFactories`-style and path-loaded extensions in exactly the loader
 * configuration the real CLI uses, instead of one that varies by test runner.
 *
 * Nesting is reference-counted so two sessions loading concurrently in one
 * process cannot have one restore the variable while the other is mid-load.
 */
export async function withoutJitiNativeImport<T>(
 fn: () => Promise<T>,
): Promise<T> {
 const previous = process.env[JITI_TRY_NATIVE];
 suppressionDepth += 1;
 process.env[JITI_TRY_NATIVE] = "0";
 try {
  return await fn();
 } finally {
  suppressionDepth -= 1;
  if (suppressionDepth === 0) {
   if (previous === undefined) delete process.env[JITI_TRY_NATIVE];
   else process.env[JITI_TRY_NATIVE] = previous;
  }
 }
}
