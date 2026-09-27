import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "@applywise/database";
import { signInSchema } from "@applywise/validation";
import { authConfig } from "./auth.config";
import { checkRateLimit, RATE_LIMITS } from "./server/rate-limit";

class InvalidCredentials extends CredentialsSignin {
  override code = "invalid_credentials";
}
class TooManyAttempts extends CredentialsSignin {
  override code = "rate_limited";
}

// Constant-time-ish failure path: always run a bcrypt compare.
let dummyHash: string | null = null;
const getDummyHash = () => (dummyHash ??= bcrypt.hashSync("not-a-real-password", 10));

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: { email: { label: "Email" }, password: { label: "Password", type: "password" } },
      async authorize(raw) {
        const parsed = signInSchema.safeParse(raw);
        if (!parsed.success) throw new InvalidCredentials();
        const { email, password } = parsed.data;
        if (!checkRateLimit(RATE_LIMITS.auth, `signin:${email}`).allowed) throw new TooManyAttempts();
        const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true, name: true, passwordHash: true } });
        const ok = await bcrypt.compare(password, user?.passwordHash ?? getDummyHash());
        if (!user || !ok) throw new InvalidCredentials();
        await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  ],
});
