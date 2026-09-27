import { z } from "zod";

export const passwordSchema = z
  .string()
  .min(10, "Use at least 10 characters")
  .max(128)
  .regex(/[a-z]/, "Include a lowercase letter")
  .regex(/[A-Z]/, "Include an uppercase letter")
  .regex(/[0-9]/, "Include a number");

export const signUpSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  email: z.email("Enter a valid email").max(320).transform((v) => v.toLowerCase()),
  password: passwordSchema,
  acceptTerms: z.literal(true, { error: "You must accept the terms and privacy policy" }),
});
export type SignUpInput = z.infer<typeof signUpSchema>;

export const signInSchema = z.object({
  email: z.email("Enter a valid email").max(320).transform((v) => v.toLowerCase()),
  password: z.string().min(1, "Password is required").max(128),
});
export type SignInInput = z.infer<typeof signInSchema>;

/** POST /api/account/delete */
export const accountDeleteSchema = z.object({
  confirmText: z.literal("DELETE", { error: 'Type "DELETE" to confirm' }),
});

export const extensionPrefillRequestSchema = z.object({
  applicationId: z.string().min(1),
});
