import { LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import type { TriageResult } from "./types";

const mockTriageResult: TriageResult = {
  category: "technical",
  priority: "high",
  sentiment: "frustrated",
  suggestedResponse: "We are looking into the CSV export issue and will have a fix shortly.",
  needsEscalation: false,
  escalationReason: null,
  summary: "Customer unable to export CSV reports.",
};

const mockEscalationResult: TriageResult = {
  category: "technical",
  priority: "critical",
  sentiment: "frustrated",
  suggestedResponse: "We take security concerns seriously and are investigating immediately.",
  needsEscalation: true,
  escalationReason: "Security concern: unauthorized access on enterprise account.",
  summary: "Enterprise customer reporting potential unauthorized access.",
};

let mockBedrockResult: TriageResult = mockTriageResult;

jest.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockImplementation(() => {
      const responseBody = JSON.stringify({
        content: [{ text: JSON.stringify(mockBedrockResult) }],
      });
      return Promise.resolve({
        body: new TextEncoder().encode(responseBody),
      });
    }),
  })),
  InvokeModelCommand: jest.fn().mockImplementation((params) => params),
}));

import { handler } from "./index";

const standardPayload = {
  ticketId: "TKT-001",
  customerId: "CUST-123",
  customerTier: "pro" as const,
  subject: "Cannot export CSV reports",
  body: "When I click the export button, nothing happens. Tried Chrome and Firefox.",
  contactEmail: "customer@example.com",
};

const escalationPayload = {
  ticketId: "TKT-002",
  customerId: "CUST-456",
  customerTier: "enterprise" as const,
  subject: "Unauthorized access to our account",
  body: "We noticed login activity from an IP address we do not recognize. Need immediate investigation.",
  contactEmail: "security@enterprise.com",
};

describe("Support Triage", () => {
  let runner: LocalDurableTestRunner;

  beforeAll(async () => {
    await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
  });

  afterAll(async () => {
    await LocalDurableTestRunner.teardownTestEnvironment();
  });

  beforeEach(() => {
    runner = new LocalDurableTestRunner({ handlerFunction: handler });
  });

  afterEach(async () => {
    await runner.reset();
  });

  it("should resolve a standard ticket after agent review", async () => {
    mockBedrockResult = mockTriageResult;
    const result = runner.run({ payload: standardPayload });

    const agentCallback = await runner.getOperation("agent-review");
    const agentDetails = await agentCallback.waitForData();
    await agentDetails.sendCallbackSuccess(JSON.stringify({
      approved: true,
      editedResponse: "We have identified a known issue with the CSV export and a fix is rolling out today.",
      agentNotes: "Known bug, fix in deploy pipeline",
    }));

    const output = await result;
    expect(output.getStatus()).toBe("SUCCEEDED");
    expect(output.getResult()).toMatchObject({
      status: "resolved",
      ticketId: "TKT-001",
    });
  });

  it("should reject when agent disapproves", async () => {
    mockBedrockResult = mockTriageResult;
    const result = runner.run({ payload: standardPayload });

    const agentCallback = await runner.getOperation("agent-review");
    const agentDetails = await agentCallback.waitForData();
    await agentDetails.sendCallbackSuccess(JSON.stringify({
      approved: false,
      editedResponse: "",
      agentNotes: "AI response is not appropriate for this case",
    }));

    const output = await result;
    expect(output.getStatus()).toBe("SUCCEEDED");
    expect(output.getResult()).toMatchObject({
      status: "rejected",
      ticketId: "TKT-001",
      finalResponse: "",
    });
  });

  it("should fail when agent review callback fails", async () => {
    mockBedrockResult = mockTriageResult;
    const result = runner.run({ payload: standardPayload });

    const agentCallback = await runner.getOperation("agent-review");
    const agentDetails = await agentCallback.waitForData();
    await agentDetails.sendCallbackFailure({
      ErrorMessage: "Callback timed out",
      ErrorType: "CallbackTimeout",
    });

    const output = await result;
    expect(output.getStatus()).toBe("FAILED");
  });

  it("should escalate and wait for specialist when flagged", async () => {
    mockBedrockResult = mockEscalationResult;
    const result = runner.run({ payload: escalationPayload });

    // Agent review
    const agentCallback = await runner.getOperation("agent-review");
    const agentDetails = await agentCallback.waitForData();
    await agentDetails.sendCallbackSuccess(JSON.stringify({
      approved: true,
      editedResponse: "",
      agentNotes: "Escalating to security team immediately",
    }));

    // Specialist review
    const specialistCallback = await runner.getOperation("specialist-review");
    const specialistDetails = await specialistCallback.waitForData();
    await specialistDetails.sendCallbackSuccess(JSON.stringify({
      response: "Investigation complete. The access was from a new VPN endpoint. No breach occurred.",
      notes: "Added IP to known-safe list",
    }));

    const output = await result;
    expect(output.getStatus()).toBe("SUCCEEDED");
    expect(output.getResult()).toMatchObject({
      status: "escalated",
      ticketId: "TKT-002",
    });
  });
});
