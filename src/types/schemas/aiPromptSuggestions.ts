import { z } from "zod";

const topicName = z.string().trim().min(1).max(120);
const topicNameDescription = "A succinct topic name, at most five words";
// Model output schemas use this shape: Claude's structured output rejects the
// range quantifier in the word-count pattern, so results are parsed with
// suggestedAiTopicSchema after generation.
export const generatedAiTopicSchema = z.object({
  name: topicName.describe(topicNameDescription),
  prompts: z.array(z.string().trim().min(1).max(500)).length(5),
});
export const suggestedAiTopicSchema = generatedAiTopicSchema.extend({
  name: topicName
    .regex(
      /^\S+(?:\s+\S+){0,4}$/,
      "Generated topic names must contain five words or fewer.",
    )
    .describe(topicNameDescription),
});
export const generateAiPromptsSchema = z.object({
  projectId: z.string().uuid(),
  topic: z
    .string()
    .trim()
    .max(100)
    .optional()
    .describe(
      "A saved topic to add prompts to, or a new topic name. Omit to let the model name a new topic.",
    ),
  excludePrompts: z.array(z.string().trim().max(2000)).max(10).default([]),
  locationCode: z.number().int().positive(),
  languageCode: z.string().trim().min(2).max(10),
});
export const aiPromptSuggestionsSchema = z.looseObject({
  topic: z.string(),
  prompts: z.array(z.string()).min(1).max(5),
});
export type GenerateAiPromptsInput = z.infer<typeof generateAiPromptsSchema>;
