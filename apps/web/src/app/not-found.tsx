import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg px-4 py-20 text-center">
      <h1 className="text-2xl font-bold">Not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">This page does not exist or you do not have access to it.</p>
      <Link href="/dashboard" className="mt-6 inline-block underline">
        Back to dashboard
      </Link>
    </div>
  );
}
