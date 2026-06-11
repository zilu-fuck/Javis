import type { SidebarNavItem, WorkbenchLocale } from "./types";

export interface BuiltinNavOptions {
  categoryStats?: { category: string; count: number }[];
  appCategoryStats?: { category: string; count: number }[];
  documentCategoryStats?: { category: string; count: number }[];
  galleryCategoryStats?: { category: string; count: number }[];
  mountRoots?: { name: string; path: string }[];
  categoryLabels?: Record<string, string>;
}

export function getBuiltinSidebarNavItems(
  labels: WorkbenchLocale["labels"],
  scheduledTaskCount = 0,
  skillCount = 0,
  options?: BuiltinNavOptions,
): SidebarNavItem[] {
  const categoryLabels = options?.categoryLabels ?? {};
  const legacyCategoryStats = options?.categoryStats ?? [];
  const appCategoryStats = options?.appCategoryStats ?? [];
  const documentCategoryStats = options?.documentCategoryStats ?? legacyCategoryStats.filter(
    (s) => s.category !== "图片",
  );
  const galleryCategoryStats = options?.galleryCategoryStats ?? legacyCategoryStats.filter(
    (s) => s.category === "图片",
  );
  const mountRoots = options?.mountRoots;

  const appSubitems = categorySubitems("apps", appCategoryStats, categoryLabels);
  const docSubitems = categorySubitems("documents", documentCategoryStats, categoryLabels);
  const gallerySubitems = categorySubitems("gallery", galleryCategoryStats, categoryLabels);

  const computerSubitems = mountRoots && mountRoots.length > 0
    ? mountRoots.map((r) => ({ label: r.name, path: r.path }))
    : [
        { label: labels.kbSystemDrive, path: "C:\\" },
        { label: labels.kbDriveE, path: "E:\\" },
        { label: labels.kbDriveF, path: "F:\\" },
        { label: labels.kbDriveG, path: "G:\\" },
      ];

  return [
    {
      viewId: "chat",
      icon: "+",
      label: labels.newChat,
      group: "primary",
      order: 0,
      collapsible: true,
      subitems: [
        { label: labels.chat, mode: "chat" },
        { label: labels.project, mode: "project" },
      ],
    },
    {
      viewId: "automated",
      icon: "o",
      label: labels.automatedTasks,
      group: "primary",
      order: 1,
      badge: scheduledTaskCount,
    },
    {
      viewId: "skills",
      icon: "#",
      label: labels.skillMarket,
      group: "primary",
      order: 2,
      collapsible: true,
      subitems: [
        { label: "我的技能", skillPage: "mine", badge: skillCount },
        { label: labels.skillMarket, skillPage: "market" },
      ],
    },
    {
      viewId: "apps",
      icon: "#",
      label: labels.apps,
      group: "knowledge",
      order: 0,
      collapsible: appSubitems.length > 0,
      subitems: appSubitems,
    },
    {
      viewId: "documents",
      icon: ">",
      label: labels.documents,
      group: "knowledge",
      order: 1,
      collapsible: docSubitems.length > 0,
      subitems: docSubitems,
    },
    {
      viewId: "gallery",
      icon: ">",
      label: labels.gallery,
      group: "knowledge",
      order: 2,
      collapsible: gallerySubitems.length > 0,
      subitems: gallerySubitems,
    },
    {
      viewId: "computer",
      icon: ">",
      label: labels.thisComputer,
      group: "knowledge",
      order: 3,
      collapsible: true,
      subitems: computerSubitems,
    },
  ];
}

/** Merge workspace-defined nav items into the built-in list, sorted by order within each group. */
export function mergeSidebarNavItems(
  builtin: SidebarNavItem[],
  custom: SidebarNavItem[] = [],
): SidebarNavItem[] {
  const merged = [...builtin];
  for (const item of custom) {
    const idx = merged.findIndex((b) => b.viewId === item.viewId);
    if (idx >= 0) {
      merged[idx] = item;
    } else {
      merged.push(item);
    }
  }
  const groupOrder: Record<string, number> = { primary: 0, knowledge: 1, custom: 2 };
  merged.sort((a, b) => {
    const ga = groupOrder[a.group ?? "custom"] ?? 99;
    const gb = groupOrder[b.group ?? "custom"] ?? 99;
    if (ga !== gb) return ga - gb;
    return a.order - b.order;
  });
  return merged;
}

function categorySubitems(
  viewId: "apps" | "documents" | "gallery",
  stats: { category: string; count: number }[],
  labels: Record<string, string>,
) {
  return stats.map((stat) => ({
    category: stat.category,
    label: `${labels[stat.category] ?? stat.category}(${stat.count})`,
    viewId,
  }));
}
