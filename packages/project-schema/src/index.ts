import { z } from 'zod';

const projectIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const nodeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const nonEmptyString = z.string().min(1);

export const projectStatusSchema = z
  .object({
    state: z.enum(['planned', 'active', 'blocked', 'complete']),
    updatedAt: nonEmptyString,
    summary: z.string().max(1024).optional()
  })
  .strict();

export const ownershipSchema = z
  .object({
    nodeIds: z.array(nodeIdSchema).max(10_000),
    nodeIdPrefixes: z.array(nonEmptyString).max(10_000).default([])
  })
  .strict()
  .refine(
    (ownership) => new Set(ownership.nodeIds).size === ownership.nodeIds.length,
    'nodeIds must be unique'
  )
  .refine(
    (ownership) => new Set(ownership.nodeIdPrefixes).size === ownership.nodeIdPrefixes.length,
    'nodeIdPrefixes must be unique'
  );

export const changelogEntrySchema = z
  .object({
    id: nonEmptyString,
    at: nonEmptyString,
    summary: nonEmptyString
  })
  .strict();

export const storybookReferenceSchema = z
  .object({
    component: nonEmptyString,
    url: nonEmptyString
  })
  .strict();

export const screenSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    description: z.string().optional()
  })
  .strict();

export const routeSchema = z
  .object({
    path: z.string().startsWith('/'),
    screenId: nonEmptyString,
    title: z.string().optional()
  })
  .strict();

export const designSystemReferenceSchema = z
  .object({
    packageName: nonEmptyString,
    version: nonEmptyString,
    tokenSource: nonEmptyString,
    documentationUrl: nonEmptyString.optional()
  })
  .strict();

export const reactSourcePointerSchema = z
  .object({
    path: nonEmptyString,
    exportName: z.string().optional(),
    revision: nonEmptyString,
    checksum: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
  })
  .strict();

export const staticDeploymentSchema = z
  .object({
    mode: z.literal('static'),
    baseUrl: nonEmptyString,
    outputDirectory: nonEmptyString,
    assetBaseUrl: nonEmptyString.optional()
  })
  .strict();

export const agentDownloadSchema = z
  .object({
    href: nonEmptyString,
    mediaType: z.literal('application/json'),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    instructions: nonEmptyString
  })
  .strict();

export const handoffDescriptorSchema = z
  .object({
    href: nonEmptyString,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: nonEmptyString.optional(),
    manifestPath: nonEmptyString,
    reactSource: z.array(reactSourcePointerSchema).min(1),
    comments: z.array(nonEmptyString),
    developerDirections: z.array(nonEmptyString).min(1),
    agentDownload: agentDownloadSchema
  })
  .strict();

/**
 * Portable, static metadata for a project participating in a federation.
 * This contract intentionally describes references only: it does not load or
 * execute a remote module at runtime.
 */
export const projectSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    projectId: projectIdSchema,
    parentProjectId: projectIdSchema.optional(),
    role: z.enum(['shell', 'child']),
    status: projectStatusSchema,
    ownership: ownershipSchema,
    changelog: z.array(changelogEntrySchema),
    designSystem: z.array(designSystemReferenceSchema).min(1),
    screens: z.array(screenSchema).min(1),
    routes: z.array(routeSchema).min(1),
    storybook: z.array(storybookReferenceSchema).min(1),
    reactSource: z.array(reactSourcePointerSchema).min(1),
    deployment: staticDeploymentSchema,
    children: z.array(projectIdSchema).default([]),
    handoff: handoffDescriptorSchema.optional()
  })
  .strict()
  .superRefine((project, context) => {
    if (project.role === 'child' && project.parentProjectId === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'child projects require parentProjectId',
        path: ['parentProjectId']
      });
    }

    const screenIds = new Set(project.screens.map((screen) => screen.id));
    for (const [index, route] of project.routes.entries()) {
      if (!screenIds.has(route.screenId)) {
        context.addIssue({
          code: 'custom',
          message: `route references unknown screen ${route.screenId}`,
          path: ['routes', index, 'screenId']
        });
      }
    }
  });

export type Project = z.infer<typeof projectSchema>;
export type ProjectStatus = z.infer<typeof projectStatusSchema>;
export type HandoffDescriptor = z.infer<typeof handoffDescriptorSchema>;
export type ReactSourcePointer = z.infer<typeof reactSourcePointerSchema>;

export const federationSchemaVersion = '1.0' as const;
