import { equal, ok, rejects } from "node:assert/strict";
import { test } from "node:test";
import { UnifiedPlanningRunProcessor } from "./unified-planning-run-processor.ts";
import { ControlledDshRunProcessor } from "./controlled-dsh-run-processor.ts";
import { controlledDshProcessorFromEnv, unifiedPlanningProcessorFromEnv } from "./main.ts";
import type { ApprovedStepExecutor } from "../kernel/controlled-image-edit-runner.ts";

const vision = { apiKey: "parent-only", baseUrl: "https://ark.invalid", model: "vision", mock: true };
const deepSeek = { apiKey: "parent-only", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" };

test("unified DSH deployment injection stays disabled unless explicitly enabled", () => {
  equal(unifiedPlanningProcessorFromEnv({}, "/workspace", vision, deepSeek), undefined);
  equal(unifiedPlanningProcessorFromEnv({
    BOWERBIRD_UNIFIED_AGENT_DSH_ENABLED: "false",
  }, "/workspace", vision, deepSeek), undefined);
});

test("unified DSH deployment injection rejects ambiguous or incomplete configuration", async () => {
  await rejects(async () => unifiedPlanningProcessorFromEnv({
    BOWERBIRD_UNIFIED_AGENT_DSH_ENABLED: "yes",
  }, "/workspace", vision, deepSeek), /BOWERBIRD_UNIFIED_AGENT_DSH_ENABLED_invalid/);
  await rejects(async () => unifiedPlanningProcessorFromEnv({
    BOWERBIRD_UNIFIED_AGENT_DSH_ENABLED: "true",
  }, "/workspace", vision, deepSeek), /BOWERBIRD_DSH_PROFILE_TEMPLATE_missing/);
  await rejects(async () => unifiedPlanningProcessorFromEnv({
    BOWERBIRD_UNIFIED_AGENT_DSH_ENABLED: "true",
    BOWERBIRD_DSH_PROFILE_TEMPLATE: "/profile",
  }, "/workspace", vision, deepSeek), /BOWERBIRD_DSH_RUNTIME_ROOT_missing/);
  await rejects(async () => unifiedPlanningProcessorFromEnv({
    BOWERBIRD_UNIFIED_AGENT_DSH_ENABLED: "true",
    BOWERBIRD_DSH_PROFILE_TEMPLATE: "/profile",
    BOWERBIRD_DSH_RUNTIME_ROOT: "/runtime",
    BOWERBIRD_DSH_MODEL: "deepseek-chat",
  }, "/workspace", vision, deepSeek), /BOWERBIRD_DSH_MODEL_mismatch/);
});

test("unified DSH deployment injection creates the formal processor only with the closed config", () => {
  const processor = unifiedPlanningProcessorFromEnv({
    BOWERBIRD_UNIFIED_AGENT_DSH_ENABLED: "true",
    BOWERBIRD_DSH_PROFILE_TEMPLATE: "/profile",
    BOWERBIRD_DSH_RUNTIME_ROOT: "/runtime",
    BOWERBIRD_DSH_MODEL: "deepseek-v4-flash",
    DEEPSEEK_API_KEY: "parent-only",
    ARK_API_KEY: "must-not-be-forwarded-by-port",
  }, "/workspace", vision, { ...deepSeek, model: "deepseek-chat" });
  ok(processor instanceof UnifiedPlanningRunProcessor);
});

const executorFactory = () => ({ execute: async () => ({}) }) as unknown as ApprovedStepExecutor;

test("controlled DSH deployment injection stays disabled unless explicitly enabled", () => {
  equal(controlledDshProcessorFromEnv({}, deepSeek, executorFactory), undefined);
  equal(controlledDshProcessorFromEnv({
    BOWERBIRD_CONTROLLED_IMAGE_EDIT_DSH_ENABLED: "false",
  }, deepSeek, executorFactory), undefined);
});

test("controlled DSH deployment injection rejects ambiguous, incomplete or mismatched config", async () => {
  await rejects(async () => controlledDshProcessorFromEnv({
    BOWERBIRD_CONTROLLED_IMAGE_EDIT_DSH_ENABLED: "yes",
  }, deepSeek, executorFactory), /BOWERBIRD_CONTROLLED_IMAGE_EDIT_DSH_ENABLED_invalid/);
  await rejects(async () => controlledDshProcessorFromEnv({
    BOWERBIRD_CONTROLLED_IMAGE_EDIT_DSH_ENABLED: "true",
  }, deepSeek, executorFactory), /BOWERBIRD_DSH_PROFILE_TEMPLATE_missing/);
  await rejects(async () => controlledDshProcessorFromEnv({
    BOWERBIRD_CONTROLLED_IMAGE_EDIT_DSH_ENABLED: "true",
    BOWERBIRD_DSH_PROFILE_TEMPLATE: "/profile",
  }, deepSeek, executorFactory), /BOWERBIRD_DSH_RUNTIME_ROOT_missing/);
  await rejects(async () => controlledDshProcessorFromEnv({
    BOWERBIRD_CONTROLLED_IMAGE_EDIT_DSH_ENABLED: "true",
    BOWERBIRD_DSH_PROFILE_TEMPLATE: "/profile",
    BOWERBIRD_DSH_RUNTIME_ROOT: "/runtime",
    BOWERBIRD_DSH_MODEL: "deepseek-chat",
  }, deepSeek, executorFactory), /BOWERBIRD_DSH_MODEL_mismatch/);
});

test("controlled DSH deployment injection creates only the per-Run DSH processor", () => {
  const processor = controlledDshProcessorFromEnv({
    BOWERBIRD_CONTROLLED_IMAGE_EDIT_DSH_ENABLED: "true",
    BOWERBIRD_DSH_PROFILE_TEMPLATE: "/profile",
    BOWERBIRD_DSH_RUNTIME_ROOT: "/runtime",
    BOWERBIRD_DSH_MODEL: "deepseek-v4-flash",
  }, { ...deepSeek, model: "deepseek-chat" }, executorFactory);
  ok(processor instanceof ControlledDshRunProcessor);
});
