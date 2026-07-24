import type { HandoffMetadataPort } from './designer-service';

/**
 * Build-time provenance embedded in the desktop bundle. Release automation
 * replaces this module when it assembles an application; it is deliberately
 * not discovered from the launch cwd or a user-controlled filesystem path.
 */
export const DESKTOP_BUILD_METADATA = {
  packageManager: 'bun@1.3.14',
  lockfile: {
    path: 'bun.lock',
    checksum: 'f314461612f5f9e893e2ff56da51ccd003956c944481f2d6d7f990450f792898'
  },
  packages: [],
  dependencies: []
} as const;

/** An injectable port keeps release provenance deterministic and testable. */
export function createEmbeddedBuildMetadataPort(
  metadata: typeof DESKTOP_BUILD_METADATA = DESKTOP_BUILD_METADATA
): HandoffMetadataPort {
  return {
    async load() {
      if (!/^[a-f0-9]{64}$/.test(metadata.lockfile.checksum))
        throw new Error('Embedded desktop build metadata has no valid lockfile checksum');
      return {
        packageManager: metadata.packageManager,
        lockfile: { ...metadata.lockfile },
        packages: [...metadata.packages],
        dependencies: [...metadata.dependencies]
      };
    }
  };
}
