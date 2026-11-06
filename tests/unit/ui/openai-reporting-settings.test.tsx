import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import OpenAIReportingFields from "../../../src/app/(dashboard)/dashboard/providers/[id]/components/modals/OpenAIReportingFields";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const readySettings = {
  encryptionReady: true,
  adminKeyConfigured: true,
  projectId: "proj_1",
  apiKeyId: null,
  period: "month",
};
const report = {
  version: 1,
  admin: {
    scope: { kind: "project", projectId: "proj_1", apiKeyId: null },
    projects: { status: "ready", data: [{ id: "proj_1", name: "Production" }] },
    apiKeys: { status: "ready", data: [{ id: "key_1", name: "Router key" }] },
  },
};

describe("OpenAI reporting settings", () => {
  it("blocks Admin key entry until encryption is ready without requiring an inference key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          encryptionReady: false,
          adminKeyConfigured: false,
          projectId: null,
          apiKeyId: null,
          period: "month",
        })
      )
    );
    render(<OpenAIReportingFields connectionId="conn_1" />);
    const input = await screen.findByLabelText("OpenAI Admin API key");
    expect(input).toHaveProperty("disabled", true);
    expect(screen.getByText(/STORAGE_ENCRYPTION_KEY/)).toBeTruthy();
    expect(screen.queryByLabelText("Inference API key")).toBeNull();
  });

  it("uses authenticated metadata IDs and omits an untouched Admin secret on save", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body));
          requests.push({ url: input, body });
          return Response.json({ ...readySettings, apiKeyId: body.openaiReportingApiKeyId });
        }
        return Response.json(
          input.endsWith("openai-reporting") ? readySettings : { openai: report }
        );
      })
    );
    render(<OpenAIReportingFields connectionId="conn_1" />);
    await screen.findByRole("option", { name: "Router key (key_1)" });
    expect(screen.getByLabelText("OpenAI Admin API key")).toHaveProperty("value", "");
    fireEvent.change(screen.getByLabelText("Reporting API key ID"), { target: { value: "key_1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save reporting settings" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toEqual({
      url: "/api/providers/conn_1/openai-reporting",
      body: {
        openaiReportingProjectId: "proj_1",
        openaiReportingApiKeyId: "key_1",
        openaiReportingPeriod: "month",
      },
    });
  });

  it("replaces an Admin key through the reporting route and clears its input after saving", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          requests.push(JSON.parse(String(init.body)));
          return Response.json(readySettings);
        }
        return Response.json(
          input.endsWith("openai-reporting") ? readySettings : { openai: report }
        );
      })
    );
    render(<OpenAIReportingFields connectionId="conn_1" />);
    const input = await screen.findByLabelText("OpenAI Admin API key");
    fireEvent.change(input, { target: { value: "sk-admin-new-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save reporting settings" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].openaiAdminApiKey).toBe("sk-admin-new-secret");
    expect(requests[0].apiKey).toBeUndefined();
    await waitFor(() => expect(input).toHaveProperty("value", ""));
  });
});
