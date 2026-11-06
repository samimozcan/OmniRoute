"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Input, Select } from "@/shared/components";
import type {
  OpenAIReportingSettings,
  OpenAIUsageReport,
} from "@omniroute/open-sse/services/usage/openaiTypes";
import { providerText } from "../../providerCredentialText";

interface OpenAIReportingFieldsProps {
  connectionId: string;
  onUpdated?: (connectionId: string) => void;
}

async function reportingJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json();
  if (!response.ok) {
    const message = typeof body?.error === "string" ? body.error : body?.error?.message;
    throw new Error(typeof message === "string" ? message : "Unable to load OpenAI reporting");
  }
  return body as T;
}

export default function OpenAIReportingFields({
  connectionId,
  onUpdated,
}: OpenAIReportingFieldsProps) {
  const t = useTranslations("providers");
  const text = (key: string, fallback: string) => providerText(t, key, fallback);
  const [settings, setSettings] = useState<OpenAIReportingSettings | null>(null);
  const [report, setReport] = useState<OpenAIUsageReport | null>(null);
  const [adminKey, setAdminKey] = useState("");
  const [projectId, setProjectId] = useState("");
  const [apiKeyId, setApiKeyId] = useState("");
  const [period, setPeriod] = useState<OpenAIReportingSettings["period"]>("month");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const settingsUrl = `/api/providers/${encodeURIComponent(connectionId)}/openai-reporting`;
  const usageUrl = `/api/usage/${encodeURIComponent(connectionId)}`;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await reportingJson<OpenAIReportingSettings>(settingsUrl);
        if (cancelled) return;
        setSettings(result);
        setProjectId(result.projectId || "");
        setApiKeyId(result.apiKeyId || "");
        setPeriod(result.period);
        if (result.adminKeyConfigured) {
          const usage = await reportingJson<{ openai?: OpenAIUsageReport }>(usageUrl);
          if (!cancelled) setReport(usage.openai ?? null);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Unable to load OpenAI reporting");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settingsUrl, usageUrl]);

  async function save(clearAdminKey = false) {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const body = clearAdminKey
        ? { clearAdminKey: true }
        : {
            openaiReportingProjectId: projectId || null,
            openaiReportingApiKeyId: apiKeyId || null,
            openaiReportingPeriod: period,
            ...(adminKey.trim() ? { openaiAdminApiKey: adminKey.trim() } : {}),
          };
      const result = await reportingJson<OpenAIReportingSettings>(settingsUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setSettings(result);
      setAdminKey("");
      setProjectId(result.projectId || "");
      setApiKeyId(result.apiKeyId || "");
      setPeriod(result.period);
      setSaved(true);
      const usage = await reportingJson<{ openai?: OpenAIUsageReport }>(usageUrl);
      setReport(usage.openai ?? null);
      onUpdated?.(connectionId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save OpenAI reporting");
    } finally {
      setSaving(false);
    }
  }

  const projects = report?.admin.projects.data ?? [];
  const keysMatchProject = report?.admin.scope.projectId === projectId;
  const apiKeys = keysMatchProject ? (report?.admin.apiKeys.data ?? []) : [];
  const savedProjectUnverified = projectId && !projects.some((project) => project.id === projectId);
  const savedKeyUnverified = apiKeyId && !apiKeys.some((key) => key.id === apiKeyId);

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border/50 bg-surface/20 p-4">
      <h3 className="text-sm font-semibold text-text-main">
        {text("openaiReportingSettingsTitle", "OpenAI usage and cost reporting")}
      </h3>
      <p className="text-xs text-text-muted">
        {text(
          "openaiReportingOptionalHint",
          "Request limits are observed from normal API calls. An optional separate Admin API key enables organization usage and costs."
        )}
      </p>
      {loading && (
        <p role="status" className="text-xs text-text-muted">
          {text("openaiReportingLoading", "Loading reporting settings…")}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-500">
          {error}
        </p>
      )}
      {settings && (
        <>
          {!settings.encryptionReady && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {text(
                "openaiReportingEncryptionRequired",
                "Set STORAGE_ENCRYPTION_KEY on the server before adding an Admin key. Existing reporting selections can still be edited or the key removed."
              )}
            </p>
          )}
          <Input
            type="password"
            name="openaiAdminApiKey"
            label={text("openaiReportingAdminKey", "OpenAI Admin API key")}
            value={adminKey}
            onChange={(event) => {
              setAdminKey(event.target.value);
              setSaved(false);
            }}
            disabled={!settings.encryptionReady || saving}
            maxLength={4096}
            autoComplete="new-password"
            spellCheck={false}
            hint={
              settings.adminKeyConfigured
                ? text(
                    "openaiReportingAdminKeyConfigured",
                    "Admin key configured. Leave blank to keep it; enter a new key to replace it."
                  )
                : text(
                    "openaiReportingAdminKeyHint",
                    "Stored encrypted on the server and used only for official OpenAI administrative reporting."
                  )
            }
          />
          <Select
            label={text("openaiReportingProject", "Reporting project")}
            value={projectId}
            disabled={saving || !settings.adminKeyConfigured}
            options={[
              { value: "", label: text("openaiReportingOrganization", "Entire organization") },
              ...projects.map((project) => ({
                value: project.id,
                label: `${project.name} (${project.id})`,
              })),
              ...(savedProjectUnverified
                ? [
                    {
                      value: projectId,
                      label: `${projectId} (${text("openaiReportingUnverified", "metadata unavailable")})`,
                    },
                  ]
                : []),
            ]}
            onChange={(event) => {
              setProjectId(event.target.value);
              setApiKeyId("");
              setSaved(false);
            }}
            hint={report?.admin.projects.message}
          />
          <Select
            label={text("openaiReportingApiKeyId", "Reporting API key ID")}
            value={apiKeyId}
            disabled={saving || !settings.adminKeyConfigured || !projectId || !keysMatchProject}
            options={[
              {
                value: "",
                label: text("openaiReportingAllProjectKeys", "All keys in the selected project"),
              },
              ...apiKeys.map((key) => ({ value: key.id, label: `${key.name} (${key.id})` })),
              ...(savedKeyUnverified
                ? [
                    {
                      value: apiKeyId,
                      label: `${apiKeyId} (${text("openaiReportingUnverified", "metadata unavailable")})`,
                    },
                  ]
                : []),
            ]}
            onChange={(event) => {
              setApiKeyId(event.target.value);
              setSaved(false);
            }}
            hint={
              projectId && !keysMatchProject
                ? text(
                    "openaiReportingSaveProject",
                    "Save the project selection to load its API key IDs."
                  )
                : report?.admin.apiKeys.message ||
                  text(
                    "openaiReportingIdentityHint",
                    "Choose the exact API key ID from OpenAI metadata. Masked key values are never matched automatically."
                  )
            }
          />
          <Select
            label={text("openaiReportingPeriod", "Reporting period")}
            value={period}
            disabled={saving}
            options={[
              { value: "month", label: text("openaiReportingMonth", "Current month (UTC)") },
              { value: "7d", label: text("openaiReporting7d", "Last 7 calendar days (UTC)") },
              { value: "30d", label: text("openaiReporting30d", "Last 30 calendar days (UTC)") },
            ]}
            onChange={(event) => {
              setPeriod(event.target.value as OpenAIReportingSettings["period"]);
              setSaved(false);
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" loading={saving} onClick={() => void save()}>
              {text("openaiReportingSave", "Save reporting settings")}
            </Button>
            {settings.adminKeyConfigured && (
              <Button size="sm" variant="ghost" disabled={saving} onClick={() => void save(true)}>
                {text("openaiReportingRemoveAdmin", "Remove Admin key")}
              </Button>
            )}
            {saved && (
              <span role="status" className="text-xs text-green-600">
                {text("openaiReportingSaved", "Reporting settings saved")}
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
