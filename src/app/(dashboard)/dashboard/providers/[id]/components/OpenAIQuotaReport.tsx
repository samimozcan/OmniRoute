"use client";

import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import type {
  OpenAIUsageReport,
  OpenAIReportSection,
  OpenAIRateLimitWindow,
  OpenAIMoney,
} from "@omniroute/open-sse/services/usage/openaiTypes";
import { providerText } from "../providerCredentialText";

function timeLabel(value: string | null, locale: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `${date.toLocaleString(locale, { timeZone: "UTC" })} UTC`
    : "—";
}

function ReportSection<T>({
  title,
  section,
  children,
}: {
  title: string;
  section: OpenAIReportSection<T>;
  children?: ReactNode;
}) {
  const t = useTranslations("providers");
  const locale = useLocale();
  const statuses = {
    ready: providerText(t, "openaiReportReady", "Available"),
    not_configured: providerText(t, "openaiReportNotConfigured", "Admin key not configured"),
    unavailable: providerText(t, "openaiReportUnavailable", "Unavailable"),
    unauthorized: providerText(t, "openaiReportUnauthorized", "No access"),
    partial: providerText(t, "openaiReportPartial", "Partial data"),
    error: providerText(t, "openaiReportError", "Refresh failed"),
  };
  return (
    <section className="min-w-0 rounded-md border border-border/50 p-2">
      <div className="flex flex-wrap items-center justify-between gap-1">
        <h4 className="font-medium text-text-main">{title}</h4>
        <span
          className={
            section.status === "ready" ? "text-text-muted" : "text-amber-600 dark:text-amber-400"
          }
        >
          {statuses[section.status]}
          {section.stale && ` · ${providerText(t, "openaiReportStale", "Stale")}`}
        </span>
      </div>
      {section.data !== null && <div className="mt-1 text-text-main">{children}</div>}
      {section.message && <p className="mt-1 break-words text-text-muted">{section.message}</p>}
      {section.fetchedAt && (
        <p className="mt-1 text-[10px] text-text-muted">
          {providerText(t, "openaiReportFetched", "Fetched")}:{" "}
          {timeLabel(section.fetchedAt, locale)}
        </p>
      )}
    </section>
  );
}

function ObservedWindow({
  label,
  window,
}: {
  label: string;
  window: OpenAIRateLimitWindow | null;
}) {
  const t = useTranslations("providers");
  const locale = useLocale();
  if (!window) {
    return (
      <p className="text-text-muted">
        {label}: {providerText(t, "openaiReportNotObserved", "Not observed")}
      </p>
    );
  }
  const value = (number: number | null) => (number === null ? "—" : number.toLocaleString(locale));
  return (
    <div className="space-y-0.5">
      <p className="text-text-main">
        {label}:{" "}
        <span className="tabular-nums font-medium">
          {value(window.remaining)} / {value(window.limit)}
        </span>{" "}
        {providerText(t, "openaiReportRemainingLimit", "remaining / limit")}
        {window.stale && (
          <span className="ml-1 text-amber-600 dark:text-amber-400">
            {providerText(t, "openaiReportStale", "Stale")}
          </span>
        )}
      </p>
      <p className="text-[10px] text-text-muted">
        {providerText(t, "openaiReportObserved", "Observed")}:{" "}
        {timeLabel(window.observedAt, locale)}
        {window.resetAt &&
          ` · ${providerText(t, "openaiReportReset", "Reset")}: ${timeLabel(window.resetAt, locale)}`}
      </p>
    </div>
  );
}

export default function OpenAIQuotaReport({ report }: { report: OpenAIUsageReport }) {
  const t = useTranslations("providers");
  const locale = useLocale();
  const text = (key: string, fallback: string) => providerText(t, key, fallback);
  const number = (value: number) => value.toLocaleString(locale);
  const money = (amount: OpenAIMoney) =>
    `${amount.value.toLocaleString(locale, { maximumFractionDigits: 6 })} ${amount.currency}`;
  const { admin, rateLimits } = report;
  const scope =
    admin.scope.kind === "api_key"
      ? `${text("openaiReportKeyScope", "API key")}: ${admin.scope.apiKeyId} · ${text("openaiReportProjectScope", "Project")}: ${admin.scope.projectId}`
      : admin.scope.kind === "project"
        ? `${text("openaiReportProjectScope", "Project")}: ${admin.scope.projectId}`
        : text("openaiReportOrganizationScope", "Entire organization");
  const period =
    admin.period.preset === "month"
      ? text("openaiReportMonth", "Current month")
      : admin.period.preset === "7d"
        ? text("openaiReport7d", "Last 7 calendar days")
        : text("openaiReport30d", "Last 30 calendar days");

  return (
    <div className="min-w-0 space-y-3 text-xs" data-testid="openai-quota-report">
      <section className="space-y-2">
        <h3 className="font-semibold text-text-main">
          {text("openaiReportObservedLimits", "Observed request limits")}
        </h3>
        <p className="text-[11px] text-text-muted">
          {text(
            "openaiReportObservedHint",
            "Headers from actual API responses. Each model and scope is shown separately; limits may be shared."
          )}
        </p>
        {rateLimits.observations.length === 0 && (
          <p className="text-text-muted">
            {text(
              "openaiReportWaiting",
              "No rate-limit headers observed yet. Send a request through this connection, then refresh."
            )}
          </p>
        )}
        {rateLimits.observations.map((observation, index) => (
          <div
            key={`${observation.model}-${observation.projectId}-${index}`}
            className="space-y-1.5 rounded-md border border-border/50 p-2"
          >
            <p className="font-medium break-words text-text-main">
              {observation.model || text("openaiReportUnknownModel", "Model not reported")}
            </p>
            <p className="break-words text-[10px] text-text-muted">
              {text("openaiReportOrganization", "Organization")}:{" "}
              {observation.organizationId || "—"} · {text("openaiReportProjectScope", "Project")}:{" "}
              {observation.projectId || "—"}
            </p>
            <ObservedWindow
              label={text("openaiReportRequests", "Requests")}
              window={observation.requests}
            />
            <ObservedWindow
              label={text("openaiReportTokens", "Tokens")}
              window={observation.tokens}
            />
            {observation.projectTokens && (
              <ObservedWindow
                label={text("openaiReportProjectTokens", "Project tokens")}
                window={observation.projectTokens}
              />
            )}
          </div>
        ))}
      </section>
      {!admin.configured ? (
        <p className="text-text-muted">
          {text(
            "openaiReportOptionalAdmin",
            "Organization usage, costs and spend settings require an optional Admin API key in this connection’s reporting settings."
          )}
        </p>
      ) : (
        <section className="space-y-2 border-t border-border/50 pt-2">
          <h3 className="font-semibold text-text-main">
            {text("openaiReportAdminTitle", "Organization reporting")}
          </h3>
          <p className="break-words text-text-main">{scope}</p>
          <p className="text-[10px] text-text-muted">
            {period} · {timeLabel(new Date(admin.period.startTime * 1000).toISOString(), locale)} –{" "}
            {timeLabel(new Date(admin.period.endTime * 1000).toISOString(), locale)}
          </p>
          <ReportSection title={text("openaiReportUsage", "Usage")} section={admin.usage}>
            {admin.usage.data && (
              <dl className="grid grid-cols-2 gap-x-2 gap-y-1 tabular-nums">
                <dt>{text("openaiReportRequests", "Requests")}</dt>
                <dd className="text-right">{number(admin.usage.data.requests)}</dd>
                <dt>{text("openaiReportInput", "Input tokens")}</dt>
                <dd className="text-right">{number(admin.usage.data.inputTokens)}</dd>
                <dt>{text("openaiReportOutput", "Output tokens")}</dt>
                <dd className="text-right">{number(admin.usage.data.outputTokens)}</dd>
                <dt>{text("openaiReportCached", "Cached input tokens")}</dt>
                <dd className="text-right">
                  {admin.usage.data.cachedInputTokens === null
                    ? "—"
                    : number(admin.usage.data.cachedInputTokens)}
                </dd>
              </dl>
            )}
          </ReportSection>
          <ReportSection title={text("openaiReportCosts", "Recorded costs")} section={admin.costs}>
            {admin.costs.data?.amounts.length ? (
              admin.costs.data.amounts.map((amount) => (
                <p key={amount.currency} className="tabular-nums font-medium">
                  {money(amount)}
                </p>
              ))
            ) : (
              <p>{text("openaiReportNoCosts", "No cost records for this scope and period")}</p>
            )}
          </ReportSection>
          <details className="space-y-2">
            <summary className="cursor-pointer font-medium text-text-main">
              {text("openaiReportSpendSettings", "Spend caps, alerts and project rate limits")}
            </summary>
            <ReportSection
              title={text("openaiReportOrgCap", "Organization spend cap")}
              section={admin.organizationSpendLimit}
            >
              {admin.organizationSpendLimit.data && (
                <p>
                  {money(admin.organizationSpendLimit.data)} /{" "}
                  {admin.organizationSpendLimit.data.interval} ·{" "}
                  {admin.organizationSpendLimit.data.enforcement}
                </p>
              )}
            </ReportSection>
            <ReportSection
              title={text("openaiReportProjectCap", "Project spend cap")}
              section={admin.projectSpendLimit}
            >
              {admin.projectSpendLimit.data && (
                <p>
                  {money(admin.projectSpendLimit.data)} / {admin.projectSpendLimit.data.interval} ·{" "}
                  {admin.projectSpendLimit.data.enforcement}
                </p>
              )}
            </ReportSection>
            <ReportSection
              title={text("openaiReportOrgAlerts", "Organization spend alerts")}
              section={admin.organizationAlerts}
            >
              {admin.organizationAlerts.data?.length ? (
                admin.organizationAlerts.data.map((alert) => (
                  <p key={alert.id}>
                    {money(alert)} / {alert.interval}
                  </p>
                ))
              ) : (
                <p>{text("openaiReportNoAlerts", "No configured alerts")}</p>
              )}
            </ReportSection>
            <ReportSection
              title={text("openaiReportProjectAlerts", "Project spend alerts")}
              section={admin.projectAlerts}
            >
              {admin.projectAlerts.data?.length ? (
                admin.projectAlerts.data.map((alert) => (
                  <p key={alert.id}>
                    {money(alert)} / {alert.interval}
                  </p>
                ))
              ) : (
                <p>{text("openaiReportNoAlerts", "No configured alerts")}</p>
              )}
            </ReportSection>
            <ReportSection
              title={text("openaiReportProjectRates", "Configured project rate limits")}
              section={admin.projectRateLimits}
            >
              {admin.projectRateLimits.data?.length ? (
                admin.projectRateLimits.data.map((limit) => (
                  <div key={limit.id} className="mt-1 border-t border-border/30 pt-1">
                    <p className="font-medium">{limit.model}</p>
                    <p>
                      RPM:{" "}
                      {limit.requestsPerMinute === null ? "—" : number(limit.requestsPerMinute)} ·
                      TPM: {limit.tokensPerMinute === null ? "—" : number(limit.tokensPerMinute)}
                    </p>
                    {limit.requestsPerDay !== null && <p>RPD: {number(limit.requestsPerDay)}</p>}
                    {limit.imagesPerMinute !== null && (
                      <p>
                        {text("openaiReportImagesPerMinute", "Images/min")}:{" "}
                        {number(limit.imagesPerMinute)}
                      </p>
                    )}
                    {limit.audioMegabytesPerMinute !== null && (
                      <p>
                        {text("openaiReportAudioPerMinute", "Audio MB/min")}:{" "}
                        {number(limit.audioMegabytesPerMinute)}
                      </p>
                    )}
                    {limit.batchInputTokensPerDay !== null && (
                      <p>
                        {text("openaiReportBatchTokens", "Batch input tokens/day")}:{" "}
                        {number(limit.batchInputTokensPerDay)}
                      </p>
                    )}
                  </div>
                ))
              ) : (
                <p>{text("openaiReportNoRates", "No configured model rate limits returned")}</p>
              )}
            </ReportSection>
            <p className="text-[10px] text-text-muted">
              {text(
                "openaiReportCapsHint",
                "Spend caps and alert thresholds are configuration values, not prepaid credit balances. Configured rate limits do not report remaining capacity."
              )}
            </p>
          </details>
        </section>
      )}
      <div className="border-t border-border/50 pt-2 text-[11px] text-text-muted">
        <p>
          {text(
            "openaiReportBalanceUnavailable",
            "Prepaid credit balance is unavailable from these reporting APIs."
          )}
        </p>
        <a
          href="https://platform.openai.com/settings/organization/billing/overview"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-primary hover:underline"
        >
          {text("openaiReportBillingLink", "Open OpenAI billing")}
        </a>
      </div>
    </div>
  );
}
