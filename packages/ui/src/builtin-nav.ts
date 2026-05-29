import type { SidebarNavItem, WorkbenchLocale } from "./types";

export interface BuiltinNavOptions {
  categoryStats?: { category: string; count: number }[];
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
  const categoryStats = options?.categoryStats ?? [];
  const mountRoots = options?.mountRoots;

  const docCategories = categoryStats.filter(
    (s) => s.category !== "图片",
  );
  const imageCategories = categoryStats.filter(
    (s) => s.category === "图片",
  );

  const docSubitems = docCategories.length > 0
    ? docCategories.map((s) => ({
        label: `${categoryLabels[s.category] ?? s.category}(${s.count})`,
        viewId: "documents" as const,
      }))
    : [
        { label: labels.kbDocRecognition },
        { label: labels.kbCourseware },
        { label: labels.kbBooks },
        { label: labels.kbPapers },
      ];

  const gallerySubitems = imageCategories.length > 0
    ? imageCategories.map((s) => ({
        label: `${categoryLabels[s.category] ?? s.category}(${s.count})`,
        viewId: "gallery" as const,
      }))
    : [
        { label: labels.kbImageRecognition },
        { label: labels.kbPeopleImpressions },
        { label: labels.kbFootprintLocations },
        { label: labels.kbTimelineGallery },
      ];

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
      badge: skillCount,
    },
    {
      viewId: "apps",
      icon: "#",
      label: labels.apps,
      group: "knowledge",
      order: 0,
    },
    {
      viewId: "documents",
      icon: ">",
      label: labels.documents,
      group: "knowledge",
      order: 1,
      collapsible: true,
      subitems: docSubitems,
    },
    {
      viewId: "gallery",
      icon: ">",
      label: labels.gallery,
      group: "knowledge",
      order: 2,
      collapsible: true,
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
      merged[idx] = item; // workspace overrides built-in
    } else {
      merged.push(item);
    }
  }
  // Sort by group order, then by order within group
  const groupOrder: Record<string, number> = { primary: 0, knowledge: 1, custom: 2 };
  merged.sort((a, b) => {
    const ga = groupOrder[a.group] ?? 99;
    const gb = groupOrder[b.group] ?? 99;
    if (ga !== gb) return ga - gb;
    return a.order - b.order;
  });
  return merged;
}
