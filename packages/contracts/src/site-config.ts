// Configuration fields the engine reads from each edition's own site package.
export interface ModelPreset {
  service: string;
  model: string;
  baseUrlEnv: string;
  apiKeyEnv: string;
  /** Extra request fields, e.g. switching reasoning off for short structured tasks. */
  extra?: Record<string, unknown>;
  /** Output tokens added to every call's own limit for a reasoning model, which reasons before it answers. */
  reasoningTokens?: number;
  jsonMode: boolean;
  vision?: boolean;
  /** Capability → primary model for which this preset is an evaluated backup. */
  fallbackFor?: Record<string, string>;
  /** The score step's call parameters with this model, instead of the step's own (editorial/analyze.ts). */
  scoreCall?: { temperature: number; maxTokens: number; timeoutMs: number };
  /**
   * A decision service instead of a chat model (TypeSafe's System One): it answers typed questions with
   * probabilities and writes no text, so no step can use it; the admin page runs it in a step's shadow.
   */
  api?: "systemone";
}

/** The optional founder shown in the site's structured metadata. */
export interface Founder {
  name: string;
  alternateName?: string;
  jobTitle?: string;
  description?: string;
  url?: string;
  sameAs?: string[];
}
