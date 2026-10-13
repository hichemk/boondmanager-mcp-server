import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCandidateTools } from "./candidates.js";
import * as boondClient from "../services/boond-client.js";

function createMockServer() {
  return {
    registerTool: vi.fn(),
  } as unknown as McpServer;
}

function getHandler(server: McpServer, name: string) {
  const call = vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === name);
  if (!call) throw new Error(`tool ${name} not registered`);
  return call[2] as (params: unknown) => Promise<unknown>;
}

describe("registerCandidateTools", () => {
  let server: McpServer;

  beforeEach(() => {
    server = createMockServer();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates via PUT /candidates/{id}/information (issue #134)", async () => {
    registerCandidateTools(server);
    const apiSpy = vi
      .spyOn(boondClient, "apiRequest")
      .mockResolvedValue({ data: { id: "4012", type: "candidate", attributes: {} } } as never);

    const handler = getHandler(server, "boond_candidates_update");
    await handler({ id: "4012", phone1: "+33769594357" });

    const [path, method] = apiSpy.mock.calls[0];
    // The base resource returns 405 on PATCH; updates target the
    // /information sub-resource with PUT.
    expect(path).toBe("/candidates/4012/information");
    expect(method).toBe("PUT");
  });

  it("should register CRUD tools + 5 tab tools + 2 tab-write tools + 3 reference tools = 15 total", () => {
    registerCandidateTools(server);
    expect(server.registerTool).toHaveBeenCalledTimes(15);
  });

  describe("boond_candidates_technical_data_update", () => {
    it("reads the current DT then PUTs the merged payload in merge mode", async () => {
      registerCandidateTools(server);
      const apiSpy = vi.spyOn(boondClient, "apiRequest").mockImplementation(async (_path, method) => {
        if (method === undefined || method === "GET") {
          return {
            data: {
              id: "25075",
              type: "candidate",
              attributes: { skills: "Integration", activityAreas: ["systemengineer"], experience: 2 },
            },
          } as never;
        }
        return {
          data: {
            id: "25075",
            type: "candidate",
            attributes: { skills: "Integration", activityAreas: ["systemengineer", "hardwareengineer"], experience: 2 },
          },
        } as never;
      });

      const handler = getHandler(server, "boond_candidates_technical_data_update");
      const res = (await handler({
        id: "25075",
        mode: "merge",
        activityAreas: ["hardwareengineer", "systemengineer"],
        experience: 3,
      })) as { content: Array<{ text: string }> };

      expect(apiSpy.mock.calls[0][0]).toBe("/candidates/25075/technical-data");
      const [path, method, body] = apiSpy.mock.calls[1] as [
        string,
        string,
        { data: { type: string; attributes: Record<string, unknown> } },
      ];
      expect(path).toBe("/candidates/25075/technical-data");
      expect(method).toBe("PUT");
      expect(body.data.type).toBe("candidate");
      // merge: area appended once, experience untouched because already set
      expect(body.data.attributes.activityAreas).toEqual(["systemengineer", "hardwareengineer"]);
      expect(body.data.attributes).not.toHaveProperty("experience");
      expect(res.content[0].text).not.toContain("non confirmés");
    });

    it("PUTs the raw payload without a prior read in replace mode", async () => {
      registerCandidateTools(server);
      const apiSpy = vi
        .spyOn(boondClient, "apiRequest")
        .mockResolvedValue({ data: { id: "1", type: "candidate", attributes: { experience: 3 } } } as never);
      const handler = getHandler(server, "boond_candidates_technical_data_update");
      await handler({ id: "1", mode: "replace", experience: 3 });
      expect(apiSpy).toHaveBeenCalledTimes(1);
      expect(apiSpy.mock.calls[0][1]).toBe("PUT");
    });

    it("warns when the API does not echo a written field", async () => {
      registerCandidateTools(server);
      vi.spyOn(boondClient, "apiRequest").mockResolvedValue({
        data: { id: "1", type: "candidate", attributes: { experience: 1 } },
      } as never);
      const handler = getHandler(server, "boond_candidates_technical_data_update");
      const res = (await handler({ id: "1", mode: "replace", experience: 3, summary: "x" })) as {
        content: Array<{ text: string }>;
      };
      expect(res.content[0].text).toContain("non confirmés");
      expect(res.content[0].text).toContain("experience, summary");
    });
  });

  // Candidates embed their references in /candidates/{id}/technical-data exactly
  // like resources do: every reference write is a GET-then-PUT of the full array.
  describe("candidate references", () => {
    type Ref = Record<string, unknown>;
    type PutBody = { data: { id: string; type: string; attributes: { references: Ref[] } } };

    function mockDtRefs(refs: Ref[], options: { assignIds?: boolean } = {}) {
      return vi.spyOn(boondClient, "apiRequest").mockImplementation(async (_path, method, body) => {
        if (method === undefined || method === "GET") {
          return { data: { id: "691", type: "candidate", attributes: { references: refs } } } as never;
        }
        const sent = (body as PutBody | undefined)?.data.attributes.references ?? refs;
        let n = 9000;
        const next = options.assignIds ? sent.map((r) => (r.id === undefined ? { ...r, id: String(n++) } : r)) : sent;
        return { data: { id: "691", type: "candidate", attributes: { references: next } } } as never;
      });
    }

    function textOf(result: unknown): string {
      return (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    }

    it("registers the three tools with accurate annotations", () => {
      registerCandidateTools(server);
      const byName = new Map(vi.mocked(server.registerTool).mock.calls.map((c) => [c[0], c[1]]));
      expect(byName.get("boond_candidates_reference_create")?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      });
      expect(byName.get("boond_candidates_reference_update")?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      });
      expect(byName.get("boond_candidates_reference_delete")?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
    });

    it("create: appends to the candidate DT, scrubs empty dates, reports the new id", async () => {
      registerCandidateTools(server);
      const apiSpy = mockDtRefs(
        [
          {
            id: "5784",
            title: "Coach ressource",
            company: "CWF",
            description: "x",
            startMonth: "1",
            endMonth: "",
            endYear: "",
          },
        ],
        { assignIds: true }
      );
      const result = await getHandler(
        server,
        "boond_candidates_reference_create"
      )({
        candidateId: "691",
        title: "Scrum Master",
        company: "AMF",
        description: "Accompagnement Scrum",
        startMonth: 9,
        startYear: 2020,
      });

      expect(apiSpy.mock.calls[0]?.[0]).toBe("/candidates/691/technical-data");
      const [path, method, body] = apiSpy.mock.calls[1] ?? [];
      expect(path).toBe("/candidates/691/technical-data");
      expect(method).toBe("PUT");
      const data = (body as PutBody).data;
      expect(data.type).toBe("candidate");
      expect(data.id).toBe("691");
      expect(data.attributes.references).toHaveLength(2);
      // Boond rejects "" on PUT (1002): the echoed empty dates must not be sent back.
      expect(data.attributes.references[0]).not.toHaveProperty("endMonth");
      expect(data.attributes.references[0]).not.toHaveProperty("endYear");
      expect(data.attributes.references[1]).toMatchObject({ title: "Scrum Master", startMonth: 9, startYear: 2020 });
      expect(data.attributes.references[1]).not.toHaveProperty("candidateId");
      expect(textOf(result)).toMatch(/ID: 9000/);
    });

    it("update: patches only the provided fields of the targeted reference", async () => {
      registerCandidateTools(server);
      const apiSpy = mockDtRefs([
        { id: "5785", title: "Coach", company: "Wado", description: "old", startYear: "2024" },
        { id: "5786", title: "Indépendant", company: "Wado", description: "dup" },
      ]);
      await getHandler(
        server,
        "boond_candidates_reference_update"
      )({
        candidateId: "691",
        referenceId: "5785",
        description: "new",
      });
      const refs = (apiSpy.mock.calls[1]?.[2] as PutBody).data.attributes.references;
      expect(refs[0]).toEqual({ id: "5785", title: "Coach", company: "Wado", description: "new", startYear: "2024" });
      expect(refs[1]).toEqual({ id: "5786", title: "Indépendant", company: "Wado", description: "dup" });
    });

    it("update: unknown referenceId is an error listing the ids, with no PUT", async () => {
      registerCandidateTools(server);
      const apiSpy = mockDtRefs([{ id: "5785", title: "Coach" }]);
      const result = await getHandler(
        server,
        "boond_candidates_reference_update"
      )({
        candidateId: "691",
        referenceId: "1",
        title: "x",
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(textOf(result)).toMatch(/5785/);
      expect(apiSpy).toHaveBeenCalledTimes(1);
    });

    it("delete: republishes the array without the targeted reference", async () => {
      registerCandidateTools(server);
      const apiSpy = mockDtRefs([
        { id: "5785", title: "Coach" },
        { id: "5786", title: "Doublon" },
      ]);
      const result = await getHandler(
        server,
        "boond_candidates_reference_delete"
      )({
        candidateId: "691",
        referenceId: "5786",
      });
      const refs = (apiSpy.mock.calls[1]?.[2] as PutBody).data.attributes.references;
      expect(refs.map((r) => r.id)).toEqual(["5785"]);
      expect(textOf(result)).toMatch(/1 référence\(s\) restante/);
    });

    it("delete: aborts without any API call when the user cancels the elicitation", async () => {
      const elicitInput = vi.fn(async () => ({ action: "accept", content: { confirmation: "cancel" } }));
      const s = {
        registerTool: vi.fn(),
        server: { getClientCapabilities: vi.fn(() => ({ elicitation: {} })), elicitInput },
      } as unknown as McpServer;
      registerCandidateTools(s);
      const apiSpy = mockDtRefs([{ id: "5786", title: "Doublon" }]);
      const result = await getHandler(
        s,
        "boond_candidates_reference_delete"
      )({
        candidateId: "691",
        referenceId: "5786",
      });
      expect(elicitInput).toHaveBeenCalledOnce();
      expect(apiSpy).not.toHaveBeenCalled();
      expect(textOf(result)).toMatch(/annulée/);
    });

    it("delete: unknown referenceId is an error, with no PUT", async () => {
      registerCandidateTools(server);
      const apiSpy = mockDtRefs([{ id: "5785", title: "Coach" }]);
      const result = await getHandler(
        server,
        "boond_candidates_reference_delete"
      )({
        candidateId: "691",
        referenceId: "1",
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(apiSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("boond_candidates_administrative_update", () => {
    it("PUTs only the supplied fields to /candidates/{id}/administrative", async () => {
      registerCandidateTools(server);
      const apiSpy = vi.spyOn(boondClient, "apiRequest").mockResolvedValue({
        data: { id: "7", type: "candidate", attributes: { desiredSalary: { min: 50000, max: 55000 } } },
      } as never);
      const handler = getHandler(server, "boond_candidates_administrative_update");
      await handler({ id: "7", desiredSalary: { min: 50000, max: 55000 } });
      const [path, method, body] = apiSpy.mock.calls[0] as [
        string,
        string,
        { data: { attributes: Record<string, unknown> } },
      ];
      expect(path).toBe("/candidates/7/administrative");
      expect(method).toBe("PUT");
      expect(body.data.attributes).toEqual({ desiredSalary: { min: 50000, max: 55000 } });
    });

    it("does not call the API when no field is supplied", async () => {
      registerCandidateTools(server);
      const apiSpy = vi.spyOn(boondClient, "apiRequest");
      const handler = getHandler(server, "boond_candidates_administrative_update");
      await handler({ id: "7" });
      expect(apiSpy).not.toHaveBeenCalled();
    });
  });

  it("should register all CRUD tools", () => {
    registerCandidateTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_candidates_search");
    expect(names).toContain("boond_candidates_get");
    expect(names).toContain("boond_candidates_create");
    expect(names).toContain("boond_candidates_update");
    expect(names).toContain("boond_candidates_delete");
  });

  it("should register all 5 tab tools", () => {
    registerCandidateTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_candidates_information");
    expect(names).toContain("boond_candidates_technical_data");
    expect(names).toContain("boond_candidates_administrative");
    expect(names).toContain("boond_candidates_actions");
    expect(names).toContain("boond_candidates_positionings");
  });

  it("should register tab tools as readOnly and non-destructive", () => {
    registerCandidateTools(server);
    const tabCalls = vi
      .mocked(server.registerTool)
      .mock.calls.filter(
        (c) =>
          typeof c[0] === "string" &&
          [
            "boond_candidates_information",
            "boond_candidates_technical_data",
            "boond_candidates_administrative",
            "boond_candidates_actions",
            "boond_candidates_positionings",
          ].includes(c[0] as string)
      );

    expect(tabCalls).toHaveLength(5);
    for (const call of tabCalls) {
      const [, metadata] = call;
      expect(metadata.annotations?.readOnlyHint).toBe(true);
      expect(metadata.annotations?.destructiveHint).toBe(false);
    }
  });
});
