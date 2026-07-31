/**
 * Minimal type declarations for prepare-package-lib.mjs.
 */

export function generatePackageJson(rootPkg: Record<string, unknown>): Record<string, unknown>;
export function isDistArtifact(filename: string): boolean;
export function copyDistArtifacts(distDir: string, packageDir: string): void;
export function verifyNoSymlinks(packageDir: string): void;
export function packageTarball(rootDir: string): string;
export function preparePackage(rootDir: string): Record<string, unknown>;