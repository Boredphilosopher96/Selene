/**
 * Build-time provenance for generated projects. Release assembly may replace
 * this module, but templates only receive it through the narrow host port.
 * It is never discovered from a launch directory or network at runtime.
 */
export interface GeneratedProjectToolchainManifest {
  readonly format: 'selene-generated-project-toolchain/v1';
  readonly bunVersion: string;
  readonly packages: {
    readonly react: string;
    readonly reactDom: string;
    readonly vite: string;
    readonly viteReact: string;
    readonly typescript: string;
    readonly storybook: string;
    readonly storybookReactVite: string;
    readonly storybookAddonA11y: string;
  };
}

export interface GeneratedProjectToolchainManifestPort {
  load(): GeneratedProjectToolchainManifest;
}

/** The sole embedded version provenance for generated project output. */
export const EMBEDDED_GENERATED_PROJECT_TOOLCHAIN: GeneratedProjectToolchainManifest =
  Object.freeze({
    format: 'selene-generated-project-toolchain/v1',
    bunVersion: '1.3.14',
    packages: Object.freeze({
      react: '19.2.8',
      reactDom: '19.2.8',
      vite: '8.1.5',
      viteReact: '6.0.4',
      typescript: '7.0.2',
      storybook: '10.5.4',
      storybookReactVite: '10.5.4',
      storybookAddonA11y: '10.5.4'
    })
  });

const exactSemver =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function validateGeneratedProjectToolchainManifest(
  value: unknown
): GeneratedProjectToolchainManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('generated project toolchain manifest is invalid');
  const manifest = value as Record<string, unknown>;
  if (manifest.format !== 'selene-generated-project-toolchain/v1')
    throw new Error('generated project toolchain format is invalid');
  const packages = manifest.packages;
  if (typeof packages !== 'object' || packages === null || Array.isArray(packages))
    throw new Error('generated project package manifest is invalid');
  const names = [
    'react',
    'reactDom',
    'vite',
    'viteReact',
    'typescript',
    'storybook',
    'storybookReactVite',
    'storybookAddonA11y'
  ] as const;
  const packageRecord = packages as Record<string, unknown>;
  const version = (name: string, candidate: unknown): string => {
    if (typeof candidate !== 'string' || !exactSemver.test(candidate))
      throw new Error(`generated project ${name} must be an exact semantic version`);
    return candidate;
  };
  const normalized = Object.fromEntries(
    names.map((name) => [name, version(name, packageRecord[name])])
  ) as GeneratedProjectToolchainManifest['packages'];
  const bunVersion = version('Bun', manifest.bunVersion);
  if (normalized.react !== normalized.reactDom)
    throw new Error('generated project react and react-dom versions must match');
  if (
    normalized.storybook !== normalized.storybookReactVite ||
    normalized.storybook !== normalized.storybookAddonA11y
  )
    throw new Error('generated project Storybook package versions must match');
  return { format: 'selene-generated-project-toolchain/v1', bunVersion, packages: normalized };
}

/** Injection seam for release assembly and host fixtures; returns inert copied data. */
export function createEmbeddedGeneratedProjectToolchainPort(
  manifest: GeneratedProjectToolchainManifest = EMBEDDED_GENERATED_PROJECT_TOOLCHAIN
): GeneratedProjectToolchainManifestPort {
  const validated = validateGeneratedProjectToolchainManifest(manifest);
  return Object.freeze({
    load: () => structuredClone(validated)
  });
}
