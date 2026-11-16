import { useEffect, useState } from "react";

import type { SelectOption } from "../components/SelectPicker";
import { agentApi, type AgentModels, type AgentRuntimeDescriptor } from "./agent";
import { t } from "./i18n";
import { readPref, writePref } from "./uiPrefs";

/**
 * 各运行时上次选择的模型（runtimeId → 模型 id）。
 *
 * 对话页与「用 Agent 修复」的任务启动共用这一份记录：在任一处选了模型，
 * 另一处下次打开时直接沿用。
 */
const MODEL_PREF_KEY = "tapd.chat-models.v1";

/** 每个运行时最近选择的模型列表（runtimeId → 模型 id，最新在前）。 */
const RECENT_PREF_KEY = "tapd.model-recents.v1";
/** 模型菜单里最多展示的最近选择数量。 */
const RECENT_LIMIT = 5;

/**
 * 读取某个运行时上次选择的模型。
 *
 * 返回 `null` 表示没有记录（此时应回退到配置里的默认模型）；空字符串是
 * 用户显式选择的「默认模型」，需要与「没有记录」区分开。
 */
export function readRememberedModel(runtimeId: string): string | null {
  const stored = readPref<Record<string, unknown>>(MODEL_PREF_KEY);
  if (!stored || typeof stored !== "object") return null;
  const value = stored[runtimeId];
  return typeof value === "string" ? value : null;
}

/** 读取某个运行时最近选择的模型（最新在前，最多 5 个）。 */
export function readRecentModels(runtimeId: string): string[] {
  if (!runtimeId) return [];
  const stored = readPref<Record<string, unknown>>(RECENT_PREF_KEY);
  if (!stored || typeof stored !== "object") return [];
  const value = stored[runtimeId];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .slice(0, RECENT_LIMIT);
}

/** 只更新「最近选择」，不改变上次选择 / 默认模型语义。 */
export function pushRecentModel(runtimeId: string, model: string): void {
  const value = model.trim();
  if (!runtimeId || !value) return;
  const stored = readPref<Record<string, unknown>>(RECENT_PREF_KEY);
  const next: Record<string, string[]> = {};
  if (stored && typeof stored === "object") {
    for (const [id, items] of Object.entries(stored)) {
      if (Array.isArray(items)) {
        next[id] = items.filter((item): item is string => typeof item === "string");
      }
    }
  }
  const recent = readRecentModels(runtimeId).filter((item) => item !== value);
  next[runtimeId] = [value, ...recent].slice(0, RECENT_LIMIT);
  writePref(RECENT_PREF_KEY, next);
}

/** 记住本次选择的模型；模型 id 与运行时相关，因此按运行时分别保存。 */
export function rememberModel(runtimeId: string, model: string): void {
  if (!runtimeId) return;
  const stored = readPref<Record<string, unknown>>(MODEL_PREF_KEY);
  const next: Record<string, string> = {};
  if (stored && typeof stored === "object") {
    for (const [id, value] of Object.entries(stored)) {
      if (typeof value === "string") next[id] = value;
    }
  }
  next[runtimeId] = model;
  writePref(MODEL_PREF_KEY, next);
  pushRecentModel(runtimeId, model);
}

/**
 * 运行时模型列表：OpenCode 系列由后端跑 `models` 子命令读取，其余回退
 * 运行时目录里的静态建议。切换运行时自动重新读取，失败时返回 `null`。
 */
export function useRuntimeModels(runtimeId: string): {
  models: AgentModels | null;
  loading: boolean;
} {
  const [models, setModels] = useState<AgentModels | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!runtimeId) {
      setModels(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setModels(null);
    void agentApi
      .models(runtimeId)
      .then((result) => {
        if (!cancelled) setModels(result);
      })
      .catch(() => {
        if (!cancelled) setModels(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runtimeId]);

  return { models, loading };
}

/**
 * 构建模型选项：首项固定为「默认模型」；随后是最近选择的模型（最多 5 个，
 * 单独分组），再是探测结果 / 静态建议；当前值不在列表里时仍保留为可选项。
 */
export function buildModelOptions(
  discovered: AgentModels | null,
  staticModels: AgentRuntimeDescriptor["models"] | undefined,
  current: string,
  recents: string[] = [],
): SelectOption[] {
  // 先把「模型 id → 展示信息」收集好，最近选择才能复用同样的 label。
  const known = new Map<string, SelectOption>();
  const fetched = discovered?.models ?? [];
  if (fetched.length > 0) {
    for (const item of fetched) {
      const value = item.id.trim();
      if (!value || known.has(value)) continue;
      known.set(value, {
        value,
        label: item.label || value,
        description: item.description,
      });
    }
  } else {
    for (const item of staticModels ?? []) {
      const value = item.trim();
      if (!value || known.has(value)) continue;
      known.set(value, { value, label: value });
    }
  }

  const options: SelectOption[] = [
    {
      value: "",
      label: t("chat.defaultModel"),
      description: t("chat.runtimeDefaultModel"),
    },
  ];
  const added = new Set<string>();

  // 最近选择：即使模型已从 CLI 列表消失也保留可选。
  for (const item of recents) {
    const value = item.trim();
    if (!value || added.has(value)) continue;
    added.add(value);
    const info = known.get(value);
    options.push({
      value,
      label: info?.label ?? value,
      description: info?.description,
      group: t("chat.recentModels"),
    });
  }

  for (const option of known.values()) {
    if (added.has(option.value)) continue;
    added.add(option.value);
    options.push(option);
  }

  // 配置里的默认模型可能不在 CLI 返回的列表里，仍然保留为可选项。
  if (current && !added.has(current)) {
    options.push({ value: current, label: current });
  }
  return options;
}
