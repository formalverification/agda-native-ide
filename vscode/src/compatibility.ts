// File: vscode/src/compatibility.ts

export const testedModeVersions: readonly string[] = ['0.10.4'];

export interface Compatibility {
  installed: string | null;
  tested: readonly string[];
  supported: boolean;
  message: string;
}

export function compatibility(installed: unknown): Compatibility {
  const version = typeof installed === 'string' ? installed : null;
  const supported = version !== null && testedModeVersions.includes(version);
  return {
    installed: version, tested: testedModeVersions, supported,
    message: supported ? `Agda mode ${version} is a tested version.` :
      `Found agda-mode-vscode ${version ?? '(not installed)'}.  Tested versions: ${testedModeVersions.join(', ')}.  The companion remains available; commands with this version are untested.`,
  };
}
