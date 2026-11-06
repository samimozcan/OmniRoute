import { z } from "zod";

export function hasOpenAIReportingFields(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return [
    "openaiAdminApiKey",
    "openaiReportingProjectId",
    "openaiReportingApiKeyId",
    "openaiReportingPeriod",
  ].some((field) => Object.hasOwn(value, field));
}

const reportingId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/, "Reporting IDs may contain letters, numbers, underscores and hyphens")
  .nullable()
  .optional();

export const openaiAdminApiKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => !/[\r\n\0]/.test(value), "Admin API keys cannot contain control characters")
  .refine((value) => !value.startsWith("enc:v1:"), "Enter a plaintext OpenAI Admin API key");

export const openaiReportingMetadataSchema = z.object({
  openaiAdminApiKey: openaiAdminApiKeySchema.nullable().optional().or(z.literal("")),
  openaiReportingProjectId: reportingId,
  openaiReportingApiKeyId: reportingId,
  openaiReportingPeriod: z.enum(["month", "7d", "30d"]).optional(),
});

export const openaiReportingSettingsSchema = openaiReportingMetadataSchema
  .extend({
    openaiAdminApiKey: openaiAdminApiKeySchema.optional(),
    clearAdminKey: z.boolean().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.clearAdminKey && data.openaiAdminApiKey !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["openaiAdminApiKey"],
        message: "Replace or clear the Admin key in separate requests",
      });
    }
  });
