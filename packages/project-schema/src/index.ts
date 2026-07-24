import { z } from 'zod';

/**
 * This is intentionally an empty envelope. The product schema is owned by the
 * design workstream and must be added there rather than guessed in the UI.
 */
export const projectSchema = z.object({}).strict();

export type Project = z.infer<typeof projectSchema>;
