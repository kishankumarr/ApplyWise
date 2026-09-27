import type { NextAuthConfig } from "next-auth";

/** Edge-safe Auth.js configuration shared by middleware and the full server config. */
export const PROTECTED_PREFIXES = ["/onboarding", "/dashboard", "/jobs", "/applications", "/resume", "/profile", "/settings", "/admin"];

export const authConfig = {
  pages: { signIn: "/sign-in" },
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 7 },
  trustHost: true,
  providers: [],
  callbacks: {
    authorized({ auth, request }) {
      const path = request.nextUrl.pathname;
      const isProtected = PROTECTED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
      if (isProtected) return !!auth?.user;
      return true;
    },
    jwt({ token, user }) {
      if (user?.id) token.uid = user.id;
      return token;
    },
    session({ session, token }) {
      if (token.uid && session.user) session.user.id = String(token.uid);
      return session;
    },
  },
} satisfies NextAuthConfig;
