import {
  LOCAL_MACHINE_IDENTITY,
  isStableMachineIdentity,
} from "../src/tailnet-peer-registry";

export const MACHINE_GROUP_PREFERENCES_STORAGE_KEY = "wolfpack-machine-group-preferences";
const MACHINE_GROUP_PREFERENCES_STORAGE_VERSION = 1;

export type MachineGroupSurface = "main" | "sidebar";

export interface MachineGroupPreferences {
  readonly order: readonly string[];
  readonly collapsed: Readonly<Record<MachineGroupSurface, readonly string[]>>;
}

type MachineGroupPreferencesStorageReader = Pick<Storage, "getItem">;
type MachineGroupPreferencesStorageWriter = Pick<Storage, "setItem">;

export const DEFAULT_MACHINE_GROUP_PREFERENCES: MachineGroupPreferences = {
  order: [],
  collapsed: { main: [], sidebar: [] },
};

function isMachineIdentity(value: unknown): value is string {
  return value === LOCAL_MACHINE_IDENTITY || isStableMachineIdentity(value);
}

function uniqueMachineIdentities(values: readonly unknown[]): string[] {
  const identities: string[] = [];
  for (const value of values) {
    if (isMachineIdentity(value) && !identities.includes(value)) identities.push(value);
  }
  return identities;
}

function normalizedPreferences(preferences: MachineGroupPreferences): MachineGroupPreferences {
  return {
    order: uniqueMachineIdentities(preferences.order),
    collapsed: {
      main: uniqueMachineIdentities(preferences.collapsed.main),
      sidebar: uniqueMachineIdentities(preferences.collapsed.sidebar),
    },
  };
}

export function loadMachineGroupPreferences(
  storage: MachineGroupPreferencesStorageReader | null,
): MachineGroupPreferences {
  if (!storage) return DEFAULT_MACHINE_GROUP_PREFERENCES;
  try {
    const raw = storage.getItem(MACHINE_GROUP_PREFERENCES_STORAGE_KEY);
    if (!raw) return DEFAULT_MACHINE_GROUP_PREFERENCES;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return DEFAULT_MACHINE_GROUP_PREFERENCES;
    const record = parsed as Record<string, unknown>;
    if (record.version !== MACHINE_GROUP_PREFERENCES_STORAGE_VERSION || !Array.isArray(record.order)) {
      return DEFAULT_MACHINE_GROUP_PREFERENCES;
    }
    const collapsed = record.collapsed;
    if (!collapsed || typeof collapsed !== "object" || Array.isArray(collapsed)) {
      return DEFAULT_MACHINE_GROUP_PREFERENCES;
    }
    const surfaces = collapsed as Record<string, unknown>;
    if (!Array.isArray(surfaces.main) || !Array.isArray(surfaces.sidebar)) {
      return DEFAULT_MACHINE_GROUP_PREFERENCES;
    }
    return {
      order: uniqueMachineIdentities(record.order),
      collapsed: {
        main: uniqueMachineIdentities(surfaces.main),
        sidebar: uniqueMachineIdentities(surfaces.sidebar),
      },
    };
  } catch {
    return DEFAULT_MACHINE_GROUP_PREFERENCES;
  }
}

export function saveMachineGroupPreferences(
  storage: MachineGroupPreferencesStorageWriter | null,
  preferences: MachineGroupPreferences,
): boolean {
  if (!storage) return false;
  try {
    const normalized = normalizedPreferences(preferences);
    storage.setItem(MACHINE_GROUP_PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: MACHINE_GROUP_PREFERENCES_STORAGE_VERSION,
      order: normalized.order,
      collapsed: normalized.collapsed,
    }));
    return true;
  } catch {
    return false;
  }
}

export function setMachineGroupCollapsed(
  preferences: MachineGroupPreferences,
  surface: MachineGroupSurface,
  identity: string,
  collapsed: boolean,
): MachineGroupPreferences {
  const normalized = normalizedPreferences(preferences);
  if (!isMachineIdentity(identity)) return normalized;
  const surfaceCollapsed = normalized.collapsed[surface];
  const nextCollapsed = collapsed
    ? uniqueMachineIdentities([...surfaceCollapsed, identity])
    : surfaceCollapsed.filter(candidate => candidate !== identity);
  return {
    ...normalized,
    collapsed: { ...normalized.collapsed, [surface]: nextCollapsed },
  };
}

export function reconcileMachineOrder(
  stored: readonly string[],
  visible: readonly string[],
): string[] {
  const reconciled = uniqueMachineIdentities(stored);
  for (const identity of uniqueMachineIdentities(visible)) {
    if (!reconciled.includes(identity)) reconciled.push(identity);
  }
  return reconciled;
}

export function moveMachineRelative(
  order: readonly string[],
  moving: string,
  target: string,
  placement: "before" | "after",
): string[] {
  const normalized = uniqueMachineIdentities(order);
  if (moving === target || !normalized.includes(moving) || !normalized.includes(target)) return normalized;
  const withoutMoving = normalized.filter(identity => identity !== moving);
  const targetIndex = withoutMoving.indexOf(target);
  withoutMoving.splice(placement === "before" ? targetIndex : targetIndex + 1, 0, moving);
  return withoutMoving;
}

export function orderMachineGroups<TGroup>(
  groups: readonly TGroup[],
  order: readonly string[],
  identityFor: (group: TGroup) => string,
): TGroup[] {
  const rank = new Map(reconcileMachineOrder(order, groups.map(identityFor)).map((identity, index) => [identity, index]));
  return groups
    .map((group, index) => ({ group, index }))
    .sort((left, right) => (rank.get(identityFor(left.group)) ?? Number.MAX_SAFE_INTEGER)
      - (rank.get(identityFor(right.group)) ?? Number.MAX_SAFE_INTEGER) || left.index - right.index)
    .map(({ group }) => group);
}
