import { checkLocalProvider, describeAiProvider, getAiConfig } from "@applywise/ai";
import { listConnectors, UNSUPPORTED_INTEGRATIONS } from "@applywise/job-engine";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@applywise/ui";
import { PageHeader } from "@/components/page-header";
import { SettingsNav } from "@/components/settings-nav";
import { ExtensionTokens } from "@/components/settings/extension-tokens";
import { platformLabel } from "@/lib/format";
import { emailProviderInfo } from "@/server/services/email.service";

export const metadata = { title: "Integrations" };
export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const connectors = listConnectors();
  const email = emailProviderInfo();
  const aiConfig = getAiConfig();
  const ai = describeAiProvider(aiConfig);
  const health = ai.configured && aiConfig.provider !== "anthropic" ? await checkLocalProvider(aiConfig) : null;
  return (
    <div>
      <PageHeader title="Settings" />
      <SettingsNav active="integrations" />
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Job sources</CardTitle>
            <CardDescription>Only official APIs, partner feeds, forwarded alerts, manual/CSV entry, career-page URLs and user-triggered browser import are supported.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {connectors.map(({ key, connector, configured }) => (
                <li key={key} className="flex items-start justify-between gap-3 py-3 text-sm">
                  <div>
                    <p className="font-medium">{key}</p>
                    <p className="text-muted-foreground">{connector.description}</p>
                    <p className="text-xs text-muted-foreground">Class: {connector.integrationClass}</p>
                  </div>
                  <Badge variant={configured ? "success" : "secondary"}>{configured ? "Enabled" : "Disabled"}</Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Not directly integrated</CardTitle>
            <CardDescription>These platforms require partnerships we do not have; use the compliant alternatives.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3 text-sm">
              {UNSUPPORTED_INTEGRATIONS.map((u) => (
                <li key={u.platform}>
                  <p className="font-medium">
                    {platformLabel(u.platform)} <Badge variant="outline">unsupported</Badge>
                  </p>
                  <p className="text-muted-foreground">{u.reason}</p>
                  <p className="text-xs">Alternatives: {u.alternatives.join(" · ")}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Email provider</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <p>
              {email.name}: {email.label}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">AI provider</CardTitle>
            <CardDescription>Set with AI_PROVIDER in .env (anthropic, ollama or openai_compatible). Used only for users who enable AI processing.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm" data-testid="ai-provider">
            <p className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{ai.label}</span>
              <Badge variant={ai.configured && (health?.ok ?? true) ? "success" : "secondary"}>
                {ai.disabled
                  ? "Disabled (AI_DISABLED=true) - rule-based fallbacks in use"
                  : !ai.configured
                    ? "Not configured - rule-based fallbacks in use"
                    : health
                      ? health.ok
                        ? "Reachable"
                        : "Unavailable"
                      : "Configured"}
              </Badge>
            </p>
            {health ? <p className="text-muted-foreground">{health.message}</p> : null}
            {!ai.configured && !ai.disabled && aiConfig.provider === "anthropic" ? <p className="text-muted-foreground">Add ANTHROPIC_API_KEY to .env, or switch to a local model with AI_PROVIDER=ollama.</p> : null}
            <p className="text-xs text-muted-foreground">If the model is unavailable or its output fails validation, ApplyWise automatically uses its deterministic fallbacks.</p>
          </CardContent>
        </Card>
        <ExtensionTokens />
      </div>
    </div>
  );
}
